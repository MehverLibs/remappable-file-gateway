"""Hash computation with source identity checks and scalable image reads."""
from __future__ import annotations

import hashlib
import io
import os
import stat
import tempfile
import threading
import zlib
import zipfile
from pathlib import Path

from .catalog import MAX_ZIP_MEMBER_BYTES, Source, _identity, _safe_member
from .sources import ChangedDuringHashError, HashError, SourceStaleError

HASH_ALGORITHMS = ("crc32", "md5", "sha256", "ahash", "dhash", "phash")
IMAGE = {"ahash", "dhash", "phash"}
# This is deliberately a buffering split, not an eligibility limit.  Mounted
# resources may be much larger; SpooledTemporaryFile transparently moves them
# to disk rather than retaining their compressed payload in process memory.
IN_MEMORY_IMAGE_BYTES = 32 * 1024 * 1024
# A decoded-header routing threshold, not an eligibility limit.  It prevents a
# highly-compressed but enormous raster from taking the fast full-resolution
# path; such images still run through the serialized thumbnail pipeline.
FAST_PATH_MAX_PIXELS = 16 * 1024 * 1024
_LARGE_IMAGE_SEMAPHORE = threading.BoundedSemaphore(1)

from PIL import Image, UnidentifiedImageError

# Capture Pillow's host-selected default without changing its process-global
# setting.
DEFAULT_IMAGE_MAX_PIXELS = Image.MAX_IMAGE_PIXELS
_IMAGE_MAX_PIXELS_LOCK = threading.Lock()


class UnsupportedImageError(HashError):
    code = "unsupported_image"


class ImageProcessingError(HashError):
    """A valid/attempted image exhausted a system or decoder resource."""
    code = "hash_failed"


class ImageTooLargeError(HashError):
    """An image exceeds RFG's fixed pixel limit."""
    code = "image_too_large"


def _open_image(input_file):
    """Open one image under a temporary Pillow pixel-limit setting.

    Pillow consults MAX_IMAGE_PIXELS only while opening an image, so keep this
    process-global mutation within this narrow lock.
    Decoding, verification, and hashing deliberately run after it is released.
    """
    with _IMAGE_MAX_PIXELS_LOCK:
        previous_limit = Image.MAX_IMAGE_PIXELS
        try:
            Image.MAX_IMAGE_PIXELS = DEFAULT_IMAGE_MAX_PIXELS
            image = Image.open(input_file)
            width, height = image.size
            if DEFAULT_IMAGE_MAX_PIXELS is not None and width * height > DEFAULT_IMAGE_MAX_PIXELS:
                image.close()
                raise ImageTooLargeError("image exceeds the fixed pixel limit")
            return image
        except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
            raise ImageTooLargeError("image exceeds the fixed pixel limit") from error
        finally:
            Image.MAX_IMAGE_PIXELS = previous_limit


def hash_profile(algorithm: str) -> str | None:
    return "imagehash-8-v1" if algorithm in IMAGE else None


def _declares_image(source: Source) -> bool:
    """Return Pillow-backed filename indication for a source or ZIP member.

    This is deliberately derived at runtime rather than maintained as an
    extension allowlist: Pillow builds can expose different plugins and file
    extensions.  It is only a filename signal.  ``Image.open`` and decoding
    below remain authoritative, so a matching suffix cannot make arbitrary
    bytes into an image.
    """
    Image.init()
    extension = Path(source.filename).suffix.lower()
    image_format = Image.registered_extensions().get(extension)
    return image_format is not None and image_format in Image.OPEN


def _image_hash(function, image) -> str:
    """Hash the first frame without changing imagehash's conversion behavior."""
    try:
        # Containers such as GIF, TIFF, and ICO can expose multiple frames.
        # imagehash performs its own grayscale conversion, so avoid a separate
        # conversion here and preserve the established PNG hash semantics.
        image.seek(0)
    except (EOFError, OSError, ValueError) as error:
        raise UnsupportedImageError("source is not a supported image") from error
    return str(function(image, hash_size=8))


def _spool_io(callable_):
    """Run explicit temporary-payload I/O with a retryable failure boundary.

    Pillow's OSError while opening/verifying a container is an invalid-image
    result.  Direct spool writes are infrastructure I/O instead (for
    example disk full after rollover), so callers must not conflate them.
    """
    try:
        return callable_()
    except OSError as error:
        raise ImageProcessingError("temporary image storage is unavailable") from error


class _SpoolReader:
    """Pillow file-object adapter that preserves spool I/O error semantics."""
    def __init__(self, payload) -> None:
        self.payload = payload

    def read(self, *args):
        return _spool_io(lambda: self.payload.read(*args))

    def readline(self, *args):
        # Some Pillow plugins use this while probing a container, even though
        # Image.open's documented minimal file interface omits it.
        return _spool_io(lambda: self.payload.readline(*args))

    def seek(self, *args):
        return _spool_io(lambda: self.payload.seek(*args))

    def tell(self):
        return _spool_io(self.payload.tell)

    def close(self):
        """Satisfy decoders that close their input without closing our spool."""
        # compute_hash() verifies and then re-seeks this shared payload to hash it.
        # Closing the wrapped SpooledTemporaryFile here would break that path.
        pass


def _verify(root: Path, source: Source) -> Path:
    path = root / source.relative_path
    try:
        if path.is_symlink() or not path.is_file():
            raise SourceStaleError("source is unavailable")
        # Ensure resolved path does not escape the resource root.
        try:
            path.resolve(strict=True).relative_to(root.resolve(strict=True))
        except (OSError, ValueError):
            raise SourceStaleError("source is unavailable")
        st = path.stat()
    except (OSError, ValueError) as error:
        raise SourceStaleError("source is unavailable") from error
    device, inode = _identity(st)
    expected_size = source.physical_size if source.member else source.size
    if (st.st_size, st.st_mtime_ns, device, inode) != (expected_size, source.mtime_ns, source.device, source.inode):
        raise SourceStaleError("source changed since scan")
    return path


def _member_info(path: Path, source: Source) -> zipfile.ZipInfo:
    try:
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo(source.member or "")
            if (_safe_member(info.filename) != source.member or info.is_dir() or info.flag_bits & 1
                    or stat.S_ISLNK(info.external_attr >> 16)
                    or sum(candidate.filename == info.filename for candidate in archive.infolist()) != 1
                    or info.file_size != source.size or info.CRC != source.crc32
                    or info.file_size > MAX_ZIP_MEMBER_BYTES):
                raise SourceStaleError("archive member changed since scan")
            return info
    except KeyError as error:
        raise SourceStaleError("archive member is unavailable") from error
    except (OSError, zipfile.BadZipFile) as error:
        raise SourceStaleError("archive is unavailable") from error


def _chunks(root: Path, source: Source):
    path = _verify(root, source)
    if source.member is None:
        with path.open("rb") as input_file:
            while chunk := input_file.read(1024 * 1024):
                yield chunk
    else:
        _member_info(path, source)
        try:
            with zipfile.ZipFile(path) as archive, archive.open(source.member or "") as member:
                while chunk := member.read(1024 * 1024):
                    yield chunk
        except (OSError, zipfile.BadZipFile, KeyError) as error:
            raise SourceStaleError("archive member is unavailable") from error
    try:
        _verify(root, source)
    except SourceStaleError as error:
        raise ChangedDuringHashError("source changed during hash") from error


def compute_hash(root: Path, source: Source, algorithm: str) -> tuple[str, str]:
    if algorithm not in HASH_ALGORITHMS:
        raise HashError("unsupported hash algorithm")
    if algorithm == "crc32" and source.member is not None:
        _verify(root, source)
        _member_info(root / source.relative_path, source)
        return f"{source.crc32:08x}", "reused"
    if algorithm in {"crc32", "md5", "sha256"}:
        if algorithm == "crc32":
            value = 0
            for chunk in _chunks(root, source):
                value = zlib.crc32(chunk, value)
            return f"{value & 0xffffffff:08x}", "computed"
        digest = hashlib.new(algorithm)
        for chunk in _chunks(root, source):
            digest.update(chunk)
        return digest.hexdigest(), "computed"
    # Always stream through a spool.  Unlike a bytearray this has no payload
    # cap and rolls over to an unnamed disk file after the performance split.
    try:
        declared_image = _declares_image(source)
        import imagehash
        functions = {"ahash": imagehash.average_hash, "dhash": imagehash.dhash, "phash": imagehash.phash}
        with tempfile.SpooledTemporaryFile(max_size=IN_MEMORY_IMAGE_BYTES, mode="w+b") as payload:
            size = 0
            for chunk in _chunks(root, source):
                _spool_io(lambda: payload.write(chunk))
                size += len(chunk)
            _spool_io(lambda: payload.seek(0))
            # Container payload is authoritative: this accepts a real PNG with
            # an unknown extension and rejects text merely named .png.
            with _open_image(_SpoolReader(payload)) as image:
                width, height = image.size
                image.verify()
                actual_image = image.format is not None
            # Eligibility is extension OR container signal.  A declared image
            # whose payload could not be verified has already raised above.
            if not (declared_image or actual_image):
                raise UnsupportedImageError("source is not a supported image")
            # This is only a work-routing decision: no byte count or decoded
            # dimensions are rejected.  Header dimensions are available before
            # loading the full raster, including for compressed PNGs.
            large = size > IN_MEMORY_IMAGE_BYTES or width * height > FAST_PATH_MAX_PIXELS
            _spool_io(lambda: payload.seek(0))
            if not large:
                # Preserve the established in-memory code path and hash values
                # for normal-sized images.
                data = _spool_io(payload.read)
                with _open_image(io.BytesIO(data)) as image:
                    return _image_hash(functions[algorithm], image), "computed"
            # Large decode/hash work is serialized to avoid concurrent decoder
            # allocations. draft() lets compatible formats avoid full-res work;
            # thumbnail bounds the imagehash input without exposing spool paths.
            with _LARGE_IMAGE_SEMAPHORE:
                # A header-large image can have a tiny compressed payload. Move
                # it to disk too, so it receives the same large-route storage
                # characteristics as a byte-large source.
                _spool_io(payload.rollover)
                _spool_io(lambda: payload.seek(0))
                with _open_image(_SpoolReader(payload)) as image:
                    try:
                        image.draft("RGB", (2048, 2048))
                    except (OSError, ValueError):
                        pass
                    try:
                        image.seek(0)
                    except (EOFError, OSError, ValueError) as error:
                        raise UnsupportedImageError("source is not a supported image") from error
                    image.thumbnail((2048, 2048), Image.Resampling.LANCZOS, reducing_gap=3.0)
                    return _image_hash(functions[algorithm], image), "computed"
    except HashError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as error:
        raise UnsupportedImageError("source is not a supported image") from error
    except (MemoryError, OverflowError) as error:
        raise ImageProcessingError("image processing exceeded available resources") from error
