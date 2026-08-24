"""Deterministic fixtures for the RFG backend test suite.

All fixtures create self-cleaning temporary directories. No database, no
sleep, no external dependencies beyond the rfg package itself.
"""

from __future__ import annotations

import errno
import io
import json
import struct
import tempfile
import zipfile
from pathlib import Path
from typing import Any

import pytest

from rfg.catalog import ZIP_SUFFIX


@pytest.fixture
def workspace() -> Path:
    """A self-cleaning temporary directory for one test.

    Returns the workspace root (reference-runtime equivalent), containing both the
    resource library root and a sidecar data directory for Runtime state.
    """
    with tempfile.TemporaryDirectory() as base:
        base_path = Path(base)
        yield base_path


@pytest.fixture
def library_root(workspace: Path) -> Path:
    """The local resource directory (`library/`)."""
    root = workspace / "library"
    root.mkdir()
    return root


@pytest.fixture
def data_dir(workspace: Path) -> Path:
    """The Runtime data root, initially without index/ or rfg/ children."""
    d = workspace / "data"
    d.mkdir()
    return d


@pytest.fixture
def mapping_path(data_dir: Path) -> Path:
    """Default Runtime-owned mapping path."""
    return data_dir / "rfg" / "mapping.json"


# ---------------------------------------------------------------------------
# Filesystem helpers
# ---------------------------------------------------------------------------


def write_file(root: Path, relative: str, content: bytes | str) -> Path:
    """Write a single ordinary file below *root*."""
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, str):
        path.write_text(content, encoding="utf-8")
    else:
        path.write_bytes(content)
    return path


def write_empty_zip(
    root: Path,
    relative: str,
) -> Path:
    """Write an empty ZIP archive (no entries)."""
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        pass  # empty
    return path


def write_rfg_zip(
    root: Path,
    relative: str,
    entries: dict[str, bytes | str],
) -> Path:
    """Write a .rfg.zip archive with the given name→content mapping."""
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in entries.items():
            zf.writestr(name, content)
    return path


def make_encrypted_zip(path: Path) -> None:
    """Write a ZIP with a single encrypted entry (flag bit 0 set).

    Because Python's stdlib zipfile cannot create encrypted entries, we craft
    the central directory header manually so the *flag_bits* field carries bit
    0 (encrypted).
    """
    from zipfile import ZipInfo, _ZipDecrypter  # noqa: F401

    # Minimal PKZip local file header + central directory with bit 0 set.
    name = b"secret.txt"
    compressed = b"\x00" * 12  # minimal fake encrypted body
    crc = 0
    # Local file header
    local = (
        b"PK\x03\x04"
        + struct.pack("<HHHHHIIIHH", 20, 1, 0, 0, 0, crc, len(compressed), 0, len(name), 0)
        + name
        + compressed
    )
    # Central directory
    central = (
        b"PK\x01\x02"
        + struct.pack(
            "<HHHHHHIIIHHHHHII",
            20,  # version made by
            20,  # version needed
            1,  # flag bits (bit 0 = encrypted)
            0,  # compression method (stored)
            0, 0,  # dos time/date
            crc,
            len(compressed),
            0,  # uncompressed size
            len(name),
            0,  # extra field len
            0,  # comment len
            0,  # disk number
            0,  # internal attrs
            0,  # external attrs
            0,  # local header offset
        )
        + name
    )
    # End of central directory
    eocd = (
        b"PK\x05\x06"
        + struct.pack("<HHHHIIH", 0, 0, 1, 1, len(central), len(local) + len(central), 0)
    )
    path.write_bytes(local + central + eocd)


# ---------------------------------------------------------------------------
# Symlink helper
# ---------------------------------------------------------------------------


def symlink_or_skip(link: Path, target: Path, *, target_is_directory: bool = False) -> None:
    """Create a symlink, skipping the test on privilege/unsupported-platform errors.

    On Windows without Developer Mode or administrator rights,
    ``os.symlink`` raises ``OSError`` with winerror 1314
    (``ERROR_PRIVILEGE_NOT_HELD``).  This helper invokes
    ``pytest.skip`` for those errors so the test is not treated as a
    failure; all other errors are re-raised.
    """
    try:
        link.symlink_to(target, target_is_directory=target_is_directory)
    except OSError as exc:
        # Windows: ERROR_PRIVILEGE_NOT_HELD = 1314
        if getattr(exc, "winerror", None) == 1314:
            pytest.skip(f"symlink requires Developer Mode or admin on Windows: {exc}")
        # Unix-style permission errors
        if exc.errno is not None and exc.errno in (errno.EPERM, errno.EACCES):
            pytest.skip(f"symlink requires elevated privileges: {exc}")
        raise


# ---------------------------------------------------------------------------
# Mapping helpers
# ---------------------------------------------------------------------------


def mapping_entry(
    virtual_path: str,
    local_path: str,
    *,
    size_bytes: int | None = None,
    **hashes: str | None,
) -> dict[str, Any]:
    """Create a validated-style mapping entry dict."""
    entry: dict[str, Any] = {
        "virtual_path": virtual_path,
        "local_path": local_path,
    }
    if size_bytes is not None:
        entry["size_bytes"] = size_bytes
    for key, value in hashes.items():
        if value is not None:
            entry[key] = value
    return entry


def mapping_doc(*entries: dict[str, Any]) -> dict[str, Any]:
    """Create a full ``{"entries": [...]}`` doc."""
    return {"entries": list(entries)}


def save_mapping(path: Path, doc: dict[str, Any]) -> None:
    """Write a mapping document to disk (bypassing the API)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")


def small_png() -> bytes:
    """A 4×4 red PNG for deterministic image-hash tests."""
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 30, 40)).save(buf, format="PNG")
    return buf.getvalue()
