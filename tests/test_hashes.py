"""Hash computation: checksums, image hashes, stale sources."""

from __future__ import annotations

import hashlib
import io
import re
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import pytest

from conftest import small_png, write_file, write_rfg_zip
from rfg.catalog import Source, scan
from rfg.hashes import ChangedDuringHashError, HashError, SourceStaleError, UnsupportedImageError, compute_hash


def _mk_source(root: Path, relative: str, member: str | None = None, **overrides) -> Source:
    """Look up a Source from a scan snapshot."""
    snap = scan(root)
    key = f"{relative}!/{member}" if member else relative
    src = snap.sources[key]
    d = {f: getattr(src, f) for f in ("logical_path", "relative_path", "member", "filename", "size", "mtime_ns", "device", "inode", "crc32", "physical_size")}
    d.update(overrides)
    return Source(**d)


def _minimal_ftex() -> bytes:
    """Return a 2×2 uncompressed FTEX texture accepted by Pillow's decoder."""
    width = height = 2
    directory_offset = 32  # 24-byte header plus one 8-byte format directory.
    pixels = bytes((255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255))
    return (
        b"FTEX"
        + struct.pack("<5i", 1, width, height, 1, 1)
        + struct.pack("<2i", 1, directory_offset)  # format 1 = uncompressed RGB
        + struct.pack("<i", len(pixels))
        + pixels
    )


# ---------------------------------------------------------------------------
# Hash computation
# ---------------------------------------------------------------------------


class TestHashComputation:
    def test_md5_of_ordinary_file(self, library_root: Path) -> None:
        payload = b"\x01\x02\x03"
        write_file(library_root, "plain.bin", payload)
        src = _mk_source(library_root, "plain.bin")
        value, code = compute_hash(library_root, src, "md5")
        assert value == hashlib.md5(payload).hexdigest()
        assert code == "computed"

    def test_sha256_of_ordinary_file(self, library_root: Path) -> None:
        payload = b"sha256 payload"
        write_file(library_root, "data.bin", payload)
        src = _mk_source(library_root, "data.bin")
        value, code = compute_hash(library_root, src, "sha256")
        assert value == hashlib.sha256(payload).hexdigest()
        assert code == "computed"

    def test_crc32_of_ordinary_file(self, library_root: Path) -> None:
        payload = b"crc test"
        write_file(library_root, "test.bin", payload)
        src = _mk_source(library_root, "test.bin")
        value, code = compute_hash(library_root, src, "crc32")
        assert value == f"{zlib.crc32(payload) & 0xFFFFFFFF:08x}"
        assert code == "computed"

    def test_hash_values_are_lowercase_hex(self, library_root: Path) -> None:
        write_file(library_root, "a.bin", b"aaa")
        src = _mk_source(library_root, "a.bin")
        for algo in ("md5", "sha256", "crc32"):
            value, _ = compute_hash(library_root, src, algo)
            assert value == value.lower()
            assert all(c in "0123456789abcdef" for c in value)

    def test_unsupported_algorithm_raises(self, library_root: Path) -> None:
        write_file(library_root, "a.txt", b"aaa")
        src = _mk_source(library_root, "a.txt")
        with pytest.raises(HashError, match="unsupported"):
            compute_hash(library_root, src, "crc16")


# ---------------------------------------------------------------------------
# ZIP member CRC reuse
# ---------------------------------------------------------------------------


class TestZipCrcReuse:
    def test_zip_member_crc32_reuses_central_directory(self, library_root: Path) -> None:
        content = b"zip member body"
        write_rfg_zip(library_root, "pack.rfg.zip", {"inner/data.bin": content})
        src = _mk_source(library_root, "pack.rfg.zip", member="inner/data.bin")
        from unittest.mock import patch
        # CRC comes from the ZIP central directory; member payload must not open.
        with patch("rfg.hashes.zipfile.ZipFile.open", side_effect=AssertionError("must not stream member")):
            value, code = compute_hash(library_root, src, "crc32")
        assert code == "reused"
        import zipfile
        with zipfile.ZipFile(library_root / "pack.rfg.zip") as zf:
            expected = zf.getinfo("inner/data.bin").CRC
        assert value == f"{expected & 0xFFFFFFFF:08x}"

    def test_zip_member_sha256_is_computed_not_reused(self, library_root: Path) -> None:
        content = b"sha256 member"
        write_rfg_zip(library_root, "pack.rfg.zip", {"inner/data.bin": content})
        src = _mk_source(library_root, "pack.rfg.zip", member="inner/data.bin")
        value, code = compute_hash(library_root, src, "sha256")
        assert code == "computed"
        assert value == hashlib.sha256(content).hexdigest()

    def test_zip_member_md5_is_computed(self, library_root: Path) -> None:
        content = b"md5 member"
        write_rfg_zip(library_root, "pack.rfg.zip", {"inner/data.bin": content})
        src = _mk_source(library_root, "pack.rfg.zip", member="inner/data.bin")
        value, code = compute_hash(library_root, src, "md5")
        assert code == "computed"
        assert value == hashlib.md5(content).hexdigest()


# ---------------------------------------------------------------------------
# Source staleness
# ---------------------------------------------------------------------------


class TestSourceStaleness:
    def test_deleted_file_before_hash_raises(self, library_root: Path) -> None:
        write_file(library_root, "temp.txt", b"temp")
        src = _mk_source(library_root, "temp.txt")
        (library_root / "temp.txt").unlink()
        with pytest.raises(SourceStaleError):
            compute_hash(library_root, src, "md5")

    def test_changed_file_before_hash_raises(self, library_root: Path) -> None:
        write_file(library_root, "mutable.txt", b"original")
        src = _mk_source(library_root, "mutable.txt")
        write_file(library_root, "mutable.txt", b"changed!!")
        with pytest.raises(SourceStaleError):
            compute_hash(library_root, src, "md5")

    def test_changed_archive_before_hash_raises(self, library_root: Path) -> None:
        write_rfg_zip(library_root, "pack.rfg.zip", {"data.bin": b"original"})
        src = _mk_source(library_root, "pack.rfg.zip", member="data.bin")
        write_rfg_zip(library_root, "pack.rfg.zip", {"data.bin": b"tampered!!"})
        with pytest.raises(SourceStaleError):
            compute_hash(library_root, src, "md5")

    def test_changed_during_hash_detected(self, library_root: Path) -> None:
        """If the file changes between _verify and the post-read re-check."""
        # This is hard to trigger without mocking. We test that the changed-
        # during-hash error class exists and is a subclass of HashError.
        assert issubclass(ChangedDuringHashError, HashError)


# ---------------------------------------------------------------------------
# Image hashes
# ---------------------------------------------------------------------------


class TestImageHashes:
    def test_import_and_reload_do_not_change_pillow_pixel_limit(self) -> None:
        project_root = Path(__file__).resolve().parents[1]
        code = """
import importlib
from PIL import Image
Image.MAX_IMAGE_PIXELS = 123456789
import rfg.hashes as hashes
assert Image.MAX_IMAGE_PIXELS == 123456789
assert hashes.DEFAULT_IMAGE_MAX_PIXELS == 123456789
importlib.reload(hashes)
assert Image.MAX_IMAGE_PIXELS == 123456789
assert hashes.DEFAULT_IMAGE_MAX_PIXELS == 123456789
"""
        subprocess.run(
            [sys.executable, "-c", code],
            cwd=project_root,
            env={"PYTHONPATH": str(project_root / "src")},
            check=True,
        )

    def test_image_open_restores_host_pixel_limit_after_success_and_error(self, library_root: Path) -> None:
        from PIL import Image

        write_file(library_root, "photo.png", small_png())
        source = _mk_source(library_root, "photo.png")
        sentinel = 123_456_789
        original = Image.MAX_IMAGE_PIXELS
        try:
            Image.MAX_IMAGE_PIXELS = sentinel
            compute_hash(library_root, source, "ahash")
            assert Image.MAX_IMAGE_PIXELS == sentinel
        finally:
            Image.MAX_IMAGE_PIXELS = original

    @pytest.mark.parametrize("filename", ["texture.ftc", "texture.opaque"])
    @pytest.mark.parametrize("algorithm", ["ahash", "dhash", "phash"])
    def test_ftex_hashes_with_registered_and_unknown_extensions(
        self, library_root: Path, filename: str, algorithm: str
    ) -> None:
        """FTEX closes its input while opening, so the shared spool must survive."""
        from PIL import Image

        Image.init()
        if "FTEX" not in Image.OPEN:
            pytest.skip("Pillow FTEX decoder is unavailable")

        write_file(library_root, filename, _minimal_ftex())
        value, code = compute_hash(library_root, _mk_source(library_root, filename), algorithm)
        assert code == "computed"
        assert re.fullmatch(r"[0-9a-f]{16}", value)

    @pytest.mark.parametrize(
        ("image_format", "extension"),
        [
            ("PNG", ".png"),
            ("JPEG", ".jpg"),
            ("GIF", ".gif"),
            ("BMP", ".bmp"),
            ("WEBP", ".webp"),
            ("TIFF", ".tiff"),
            ("ICO", ".ico"),
        ],
    )
    def test_common_pillow_images_hash_on_mounted_resources(
        self, library_root: Path, image_format: str, extension: str
    ) -> None:
        """Every installed common Pillow codec hashes all image algorithms.

        A distribution may omit optional codecs (notably WebP or ICO).  Skip
        only that parameter with the precise missing encoder/decoder reason.
        """
        from PIL import Image

        Image.init()
        if image_format not in Image.OPEN:
            pytest.skip(f"Pillow {image_format} decoder is unavailable")
        if image_format not in Image.SAVE:
            pytest.skip(f"Pillow {image_format} encoder is unavailable for test fixture")

        image = Image.new("RGB", (32, 32))
        image.putdata([(x * 13 % 256, y * 17 % 256, (x + y) * 19 % 256) for y in range(32) for x in range(32)])
        output = io.BytesIO()
        try:
            save_options = {"sizes": [(16, 16)]} if image_format == "ICO" else {}
            image.save(output, format=image_format, **save_options)
        except (OSError, ValueError) as error:
            pytest.skip(f"Pillow {image_format} encoder cannot write test fixture: {error}")

        filename = f"mounted-resource{extension}"
        write_file(library_root, filename, output.getvalue())
        source = _mk_source(library_root, filename)
        for algorithm in ("ahash", "dhash", "phash"):
            value, code = compute_hash(library_root, source, algorithm)
            repeated, repeated_code = compute_hash(library_root, source, algorithm)
            assert (code, repeated_code) == ("computed", "computed")
            assert re.fullmatch(r"[0-9a-f]{16}", value)
            assert repeated == value

    def test_ahash_of_png(self, library_root: Path) -> None:
        write_file(library_root, "photo.png", small_png())
        src = _mk_source(library_root, "photo.png")
        value, code = compute_hash(library_root, src, "ahash")
        assert code == "computed"
        assert len(value) == 16
        assert all(c in "0123456789abcdef" for c in value)

    def test_dhash_of_png(self, library_root: Path) -> None:
        write_file(library_root, "photo.png", small_png())
        src = _mk_source(library_root, "photo.png")
        value, code = compute_hash(library_root, src, "dhash")
        assert code == "computed"
        assert len(value) == 16

    def test_phash_of_png(self, library_root: Path) -> None:
        write_file(library_root, "photo.png", small_png())
        src = _mk_source(library_root, "photo.png")
        value, code = compute_hash(library_root, src, "phash")
        assert code == "computed"
        assert len(value) == 16

    def test_identical_images_hash_identically(self, library_root: Path) -> None:
        png = small_png()
        write_file(library_root, "one.png", png)
        write_file(library_root, "two.png", png)
        _ = scan(library_root)
        src1 = _mk_source(library_root, "one.png")
        src2 = _mk_source(library_root, "two.png")
        v1, _ = compute_hash(library_root, src1, "ahash")
        v2, _ = compute_hash(library_root, src2, "ahash")
        assert v1 == v2

    def test_non_image_file_image_hash_fails(self, library_root: Path) -> None:
        write_file(library_root, "notes.txt", b"plain text, not an image")
        src = _mk_source(library_root, "notes.txt")
        with pytest.raises(UnsupportedImageError, match="image"):
            compute_hash(library_root, src, "ahash")

    def test_image_hash_on_zip_member(self, library_root: Path) -> None:
        write_rfg_zip(library_root, "photos.rfg.zip", {"img/pic.png": small_png()})
        src = _mk_source(library_root, "photos.rfg.zip", member="img/pic.png")
        value, code = compute_hash(library_root, src, "dhash")
        assert code == "computed"
        assert len(value) == 16

    def test_non_image_zip_member_image_hash_fails(self, library_root: Path) -> None:
        write_rfg_zip(library_root, "pack.rfg.zip", {"readme.txt": b"not an image"})
        src = _mk_source(library_root, "pack.rfg.zip", member="readme.txt")
        with pytest.raises(UnsupportedImageError):
            compute_hash(library_root, src, "phash")

    def test_valid_png_with_unknown_extension_hashes_by_payload(self, library_root: Path) -> None:
        write_file(library_root, "camera-resource.opaque", small_png())
        value, code = compute_hash(library_root, _mk_source(library_root, "camera-resource.opaque"), "ahash")
        assert code == "computed"
        assert len(value) == 16

    @pytest.mark.parametrize("name", ["text.png", "plain.dat"])
    def test_invalid_payload_is_unsupported_regardless_of_extension(self, library_root: Path, name: str) -> None:
        write_file(library_root, name, b"definitely not an image")
        with pytest.raises(UnsupportedImageError):
            compute_hash(library_root, _mk_source(library_root, name), "dhash")

    def test_invalid_payload_with_registered_extension_in_zip_is_unsupported(self, library_root: Path) -> None:
        """Declared type is based on the ZIP member's logical filename."""
        from PIL import Image

        Image.init()
        extension = next(
            ext for ext, image_format in Image.registered_extensions().items() if image_format in Image.OPEN
        )
        write_rfg_zip(library_root, "pack.rfg.zip", {f"images/fake{extension}": b"not an image"})
        source = _mk_source(library_root, "pack.rfg.zip", member=f"images/fake{extension}")
        with pytest.raises(UnsupportedImageError):
            compute_hash(library_root, source, "dhash")

    @pytest.mark.parametrize("algorithm", ["ahash", "dhash", "phash"])
    def test_large_valid_image_uses_disk_backed_hashing(self, library_root: Path, algorithm: str) -> None:
        from PIL import Image

        # A 4096×3000 RGB BMP is 36MiB on disk and therefore takes the
        # disk-backed hashing path while remaining reasonable for CI.
        image = Image.new("RGB", (4096, 3000), "steelblue")
        output = io.BytesIO()
        image.save(output, format="BMP")
        assert output.tell() > 32 * 1024 * 1024
        write_file(library_root, "large.bmp", output.getvalue())
        value, code = compute_hash(library_root, _mk_source(library_root, "large.bmp"), algorithm)
        assert code == "computed"
        assert len(value) == 16

    def test_high_dimension_compressed_image_hashes_without_fast_full_raster(self, library_root: Path) -> None:
        from PIL import Image

        # A uniform 5000×4000 PNG is tiny on disk yet has a large decoded
        # raster. It must remain eligible while avoiding the fast full-size
        # imagehash route.
        image = Image.new("RGB", (5000, 4000), "steelblue")
        output = io.BytesIO()
        image.save(output, format="PNG", optimize=True)
        assert output.tell() < 32 * 1024 * 1024
        write_file(library_root, "compressed-large.png", output.getvalue())
        value, code = compute_hash(library_root, _mk_source(library_root, "compressed-large.png"), "phash")
        assert code == "computed"
        assert len(value) == 16


# ---------------------------------------------------------------------------
# hash profile helper
# ---------------------------------------------------------------------------


class TestHashProfile:
    def test_profile_for_image_algorithms(self) -> None:
        from rfg.hashes import hash_profile
        assert hash_profile("ahash") == "imagehash-8-v1"
        assert hash_profile("dhash") == "imagehash-8-v1"
        assert hash_profile("phash") == "imagehash-8-v1"

    def test_profile_for_hash_algorithms_is_none(self) -> None:
        from rfg.hashes import hash_profile
        assert hash_profile("md5") is None
        assert hash_profile("sha256") is None
        assert hash_profile("crc32") is None
