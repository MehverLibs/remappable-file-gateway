"""Strict JSON mapping document validation and atomic persistence."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

HASH_FIELDS = ("crc32", "md5", "sha256", "ahash", "dhash", "phash")
ENTRY_FIELDS = {"virtual_path", "local_path", "size_bytes", *HASH_FIELDS}

def safe_path(value: Any, field: str = "path") -> str:
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value or value.startswith("/"):
        raise ValueError(f"{field} must be a non-empty safe POSIX relative path")
    if any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError(f"{field} contains an unsafe path segment")
    return value

def validate_document(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != {"entries"} or not isinstance(raw["entries"], list):
        raise ValueError("mapping document must be exactly an object with entries list")
    virtual, local, entries = set(), set(), []
    for i, item in enumerate(raw["entries"]):
        if not isinstance(item, dict) or set(item) - ENTRY_FIELDS:
            raise ValueError(f"entries[{i}] has unknown fields or is not an object")
        if not {"virtual_path", "local_path"} <= set(item):
            raise ValueError(f"entries[{i}] requires virtual_path, local_path")
        v, l = safe_path(item["virtual_path"], f"entries[{i}].virtual_path"), safe_path(item["local_path"], f"entries[{i}].local_path")
        if v in virtual or l in local: raise ValueError("virtual_path and local_path must each be unique")
        virtual.add(v); local.add(l)
        out = {"virtual_path": v, "local_path": l}
        if "size_bytes" in item:
            size = item["size_bytes"]
            if size is not None:
                if isinstance(size, bool) or not isinstance(size, int) or size < 0:
                    raise ValueError("size_bytes must be a non-negative integer or null")
                out["size_bytes"] = size
        for name in HASH_FIELDS:
            if name in item:
                value = item[name]
                if value is not None:
                    if not isinstance(value, str) or not value:
                        raise ValueError(f"{name} must be a non-empty string or null")
                    out[name] = value
        entries.append(out)
    return {"entries": entries}

def load(path: Path) -> dict[str, Any]:
    _validate_mapping_path(path)
    if not path.exists(): return {"entries": []}
    try:
        return validate_document(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise ValueError("mapping file is invalid") from error

def save(path: Path, raw: Any) -> dict[str, Any]:
    document = validate_document(raw)
    _validate_mapping_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _validate_mapping_path(path)
    payload = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        try:
            output = os.fdopen(fd, "wb")
        except BaseException:
            os.close(fd)
            raise
        with output:
            output.write(payload); output.flush(); os.fsync(output.fileno())
        os.replace(temporary, path)
        # Persist the rename where the host filesystem supports directory fsync.
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try: os.fsync(directory_fd)
            finally: os.close(directory_fd)
        except OSError:
            pass
    except BaseException:
        try: os.unlink(temporary)
        except OSError: pass
        raise
    return document


def _validate_mapping_path(path: Path) -> None:
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("mapping file must not be a symlink")
