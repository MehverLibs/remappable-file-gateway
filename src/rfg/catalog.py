"""Safe, ephemeral scanning of ordinary files and `.rfg.zip` leaves."""
from __future__ import annotations

import os
import stat
import zipfile
from dataclasses import dataclass
from pathlib import Path

ZIP_SUFFIX = ".rfg.zip"
MAX_ZIP_MEMBER_BYTES = 1024 * 1024 * 1024
MAX_ZIP_RATIO = 200
MAX_ZIP_ENTRIES = 10000
MAX_ZIP_TOTAL_BYTES = 10 * 1024 * 1024 * 1024


@dataclass(frozen=True)
class Source:
    logical_path: str
    relative_path: str
    member: str | None
    filename: str
    size: int
    mtime_ns: int
    device: int
    inode: int
    crc32: int | None = None
    physical_size: int | None = None


@dataclass(frozen=True)
class CatalogSnapshot:
    sources: dict[str, Source]
    issues: tuple[str, ...] = ()


def _safe_member(name: str) -> str | None:
    if not name or "\x00" in name or "\\" in name:
        return None
    # Validate the ZIP's raw member name. PurePosixPath normalizes repeated
    # separators and dot segments, which would otherwise hide unsafe input.
    if name.startswith("/") or any(part in {"", ".", ".."} for part in name.split("/")):
        return None
    return name


def _identity(st: os.stat_result) -> tuple[int, int]:
    # Windows inode/device values are not stable enough across normal file access.
    return (0, 0) if os.name == "nt" else (st.st_dev, st.st_ino)


def scan(root: Path) -> CatalogSnapshot:
    """Return only safe logical leaves. Problems are deliberately non-fatal."""
    sources: dict[str, Source] = {}
    issues: list[str] = []
    for base, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not (Path(base) / d).is_symlink())
        for name in sorted(names):
            path = Path(base) / name
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                st = path.stat()
                relative = path.relative_to(root).as_posix()
            except OSError:
                issues.append("unreadable local file")
                continue
            if _safe_member(relative) is None:
                issues.append("unsafe local file")
                continue
            device, inode = _identity(st)
            if not name.lower().endswith(ZIP_SUFFIX):
                sources[relative] = Source(relative, relative, None, name, st.st_size, st.st_mtime_ns, device, inode)
                continue
            try:
                with zipfile.ZipFile(path) as archive:
                    infos = archive.infolist()
                    if len(infos) > MAX_ZIP_ENTRIES:
                        issues.append("ZIP archive has too many entries")
                        continue
                    total_size = sum(info.file_size for info in infos)
                    if total_size > MAX_ZIP_TOTAL_BYTES:
                        issues.append("ZIP archive decompressed size exceeds limit")
                        continue
                    names_seen: set[str] = set()
                    duplicate_names: set[str] = set()
                    for info in infos:
                        if info.filename in names_seen:
                            duplicate_names.add(info.filename)
                        else:
                            names_seen.add(info.filename)
                    for info in infos:
                        member = _safe_member(info.filename)
                        is_link = stat.S_ISLNK(info.external_attr >> 16)
                        unsafe = (
                            member is None or info.is_dir() or bool(info.flag_bits & 1) or is_link
                            or info.file_size > MAX_ZIP_MEMBER_BYTES
                            or (info.compress_size and info.file_size / info.compress_size > MAX_ZIP_RATIO)
                            or info.filename in duplicate_names
                        )
                        if unsafe:
                            issues.append("unsafe ZIP entry")
                            continue
                        logical = f"{relative}!/{member}"
                        sources[logical] = Source(logical, relative, member, member.rsplit("/", 1)[-1],
                                                  info.file_size, st.st_mtime_ns, device, inode, info.CRC, st.st_size)
            except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile):
                issues.append("unreadable ZIP archive")
    return CatalogSnapshot(dict(sorted(sources.items())), tuple(issues))
