"""Mapped resource delivery without buffering ordinary files in memory.

Source files and ZIP members are opened *before* response headers are built so
that a preparation failure reliably produces HTTP 503 without partial status or
body headers.  Opened handles are owned by the response generator, which closes
them in ``finally`` even when the client disconnects.
"""
from __future__ import annotations

import hashlib
import mimetypes
import os
import stat
import zipfile
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO

from fastapi import Request
from fastapi.responses import Response, StreamingResponse

from .catalog import MAX_ZIP_MEMBER_BYTES, Source, _identity, _safe_member
from .sources import SourceStaleError


def _etag(entry: dict, source: Source) -> str:
    facts = "|".join((entry["virtual_path"], entry["local_path"], str(source.size), str(source.mtime_ns),
                       str(source.device), str(source.inode), str(source.crc32)))
    return '"' + hashlib.sha256(facts.encode()).hexdigest() + '"'


def _range(value: str | None, total: int) -> tuple[int, int] | None:
    if not value:
        return None
    if total == 0:
        raise ValueError
    if not value.startswith("bytes=") or "," in value:
        raise ValueError
    begin, end = value[6:].split("-", 1)
    if not begin and not end:
        raise ValueError
    if begin:
        start = int(begin)
        stop = int(end) if end else total - 1
    else:
        suffix = int(end)
        if suffix <= 0:
            raise ValueError
        start, stop = max(0, total - suffix), total - 1
    if start < 0 or start >= total or stop < start:
        raise ValueError
    return start, min(stop, total - 1)


def _prepare_ordinary(root: Path, source: Source, start: int) -> BinaryIO:
    """Open, validate (fstat), and seek an ordinary file.  Returns an open handle.

    The caller must arrange for the handle to be closed.  If validation or seek
    fails the handle is already closed before the exception propagates.
    """
    path = root / source.relative_path
    # Security containment check (same policy as _verify).
    try:
        if path.is_symlink() or not path.is_file():
            raise SourceStaleError("source is unavailable")
        path.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as error:
        raise SourceStaleError("source is unavailable") from error

    handle = path.open("rb")
    try:
        st = os.fstat(handle.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise SourceStaleError("source is unavailable")
        device, inode = _identity(st)
        if (st.st_size, st.st_mtime_ns, device, inode) != (
            source.size,
            source.mtime_ns,
            source.device,
            source.inode,
        ):
            raise SourceStaleError("source changed since scan")
        handle.seek(start)
    except BaseException:
        handle.close()
        raise
    return handle


def _prepare_archive(root: Path, source: Source, start: int) -> tuple[zipfile.ZipFile, BinaryIO, BinaryIO]:
    """Open archive, fstat fd against source, validate member, skip to *start*.

    Returns (archive, member, archive_handle).  All handles must be closed by the
    caller.  ``ZipFile`` uses the validated file object rather than reopening the
    path, so a replacement between validation and ZIP parsing cannot be served.
    The archive file is opened for fd-based identity validation before the
    ZipFile handle is created, matching the same portable identity policy
    used for ordinary files.  All resources are closed on every preparation
    error path.
    """
    path = root / source.relative_path
    # Security containment check (same policy as _prepare_ordinary).
    try:
        if path.is_symlink() or not path.is_file():
            raise SourceStaleError("source is unavailable")
        path.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as error:
        raise SourceStaleError("source is unavailable") from error

    # Open the archive file for fd-based identity validation.
    archive_handle = path.open("rb")
    try:
        st = os.fstat(archive_handle.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise SourceStaleError("source is unavailable")
        device, inode = _identity(st)
        expected_size = source.physical_size
        if (st.st_size, st.st_mtime_ns, device, inode) != (
            expected_size,
            source.mtime_ns,
            source.device,
            source.inode,
        ):
            raise SourceStaleError("source changed since scan")
    except BaseException:
        archive_handle.close()
        raise

    archive = None
    member = None
    try:
        archive = zipfile.ZipFile(archive_handle)
        try:
            info = archive.getinfo(source.member or "")
            if (
                _safe_member(info.filename) != source.member
                or info.is_dir()
                or info.flag_bits & 1
                or stat.S_ISLNK(info.external_attr >> 16)
                or sum(candidate.filename == info.filename for candidate in archive.infolist()) != 1
                or info.file_size != source.size
                or info.CRC != source.crc32
                or info.file_size > MAX_ZIP_MEMBER_BYTES
            ):
                raise SourceStaleError("archive member changed since scan")
            member = archive.open(source.member or "")
            # Skip to the requested range start.
            remaining_skip = start
            while remaining_skip:
                chunk = member.read(min(1024 * 1024, remaining_skip))
                if not chunk:
                    raise SourceStaleError("archive member ended during delivery")
                remaining_skip -= len(chunk)
        except BaseException:
            if member is not None:
                try:
                    member.close()
                except Exception:
                    pass
            raise
    except BaseException:
        if archive is not None:
            try:
                archive.close()
            except Exception:
                pass
        archive_handle.close()
        raise

    return archive, member, archive_handle


def _ordinary(handle: BinaryIO, count: int) -> Iterator[bytes]:
    """Yield *count* bytes from an already-opened, already-seeked file handle.

    The handle is closed in ``finally`` regardless of how the generator exits.
    """
    try:
        remaining = count
        while remaining:
            chunk = handle.read(min(1024 * 1024, remaining))
            if not chunk:
                raise SourceStaleError("source ended during delivery")
            remaining -= len(chunk)
            yield chunk
    finally:
        handle.close()


def _archive(
    archive: zipfile.ZipFile, member: BinaryIO, archive_handle: BinaryIO, count: int
) -> Iterator[bytes]:
    """Yield *count* bytes from an already-opened archive member.

    Both the member and the archive are closed in ``finally``.
    """
    try:
        remaining = count
        while remaining:
            chunk = member.read(min(1024 * 1024, remaining))
            if not chunk:
                raise SourceStaleError("archive member ended during delivery")
            remaining -= len(chunk)
            yield chunk
    finally:
        # Best-effort close of member then archive.
        try:
            member.close()
        except Exception:
            pass
        try:
            archive.close()
        except Exception:
            pass
        try:
            archive_handle.close()
        except Exception:
            pass


def response(request: Request, virtual_path: str, mapping: dict, catalog: dict[str, Source], root: Path) -> Response:
    entries = [entry for entry in mapping["entries"] if entry["virtual_path"] == virtual_path]
    if not entries:
        return Response(status_code=404)
    if len(entries) != 1:
        return Response(status_code=503)
    entry = entries[0]
    source = catalog.get(entry["local_path"])
    if source is None:
        return Response(status_code=503)
    total = source.size
    etag = _etag(entry, source)
    headers = {"Accept-Ranges": "bytes", "ETag": etag, "Cache-Control": "no-cache",
               "X-Content-Type-Options": "nosniff", "Content-Type": mimetypes.guess_type(virtual_path)[0] or "application/octet-stream"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    try:
        selected = _range(request.headers.get("range"), total)
    except (ValueError, OverflowError):
        headers["Content-Range"] = f"bytes */{total}"
        return Response(status_code=416, headers=headers)
    start, end = selected if selected else (0, max(0, total - 1))
    count, status = (end - start + 1 if total else 0), 206 if selected else 200
    headers["Content-Length"] = str(count)
    if selected:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    if request.method == "HEAD":
        # Match GET's pre-response source validation without streaming a body.
        try:
            if source.member:
                archive, member, archive_handle = _prepare_archive(root, source, start)
                try:
                    member.close()
                finally:
                    try:
                        archive.close()
                    finally:
                        archive_handle.close()
            else:
                _prepare_ordinary(root, source, start).close()
        except SourceStaleError:
            return Response(status_code=503)
        except Exception:
            return Response(status_code=503)
        return Response(status_code=status, headers=headers)

    # Open and validate the source *before* building StreamingResponse so that
    # any preparation failure reliably returns 503 instead of a started stream.
    try:
        if source.member:
            archive, member, archive_handle = _prepare_archive(root, source, start)
            iterator = _archive(archive, member, archive_handle, count)
        else:
            handle = _prepare_ordinary(root, source, start)
            iterator = _ordinary(handle, count)
    except SourceStaleError:
        return Response(status_code=503)
    except Exception:
        return Response(status_code=503)

    return StreamingResponse(iterator, status_code=status, headers=headers)
