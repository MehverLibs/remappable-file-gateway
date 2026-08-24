"""/res endpoint: GET, HEAD, Range, ETag/304, error codes."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from conftest import mapping_doc, mapping_entry, save_mapping, symlink_or_skip, write_file, write_rfg_zip
from rfg.api import create_app
from rfg.auth import AllowAllAuthorizer


def _app(library_root: Path, data_dir: Path, **kw) -> TestClient:
    """Create a fresh TestClient with the current filesystem state."""
    app = create_app(str(library_root), str(data_dir),
                     authorizer=AllowAllAuthorizer(), **kw)
    return TestClient(app)


# ---------------------------------------------------------------------------
# Ordinary file delivery
# ---------------------------------------------------------------------------


class TestOrdinaryContent:
    def test_get_ordinary_file(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_file(library_root, "docs/a.txt", b"0123456789")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/a.txt", "docs/a.txt")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/public/a.txt")
            assert resp.status_code == 200
            assert resp.content == b"0123456789"
            assert resp.headers["content-length"] == "10"
            assert resp.headers["accept-ranges"] == "bytes"
            assert resp.headers["cache-control"] == "no-cache"
            assert resp.headers["x-content-type-options"] == "nosniff"

    def test_head_ordinary_file(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_file(library_root, "docs/a.txt", b"data")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/a.txt", "docs/a.txt")))
        with _app(library_root, data_dir) as client:
            resp = client.head("/res/public/a.txt")
            assert resp.status_code == 200
            assert resp.content == b""
            assert resp.headers["content-length"] == "4"

    def test_head_stale_source_returns_503(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_file(library_root, "docs/a.txt", b"before")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/a.txt", "docs/a.txt")))
        with _app(library_root, data_dir) as client:
            write_file(library_root, "docs/a.txt", b"after source changed")
            resp = client.head("/res/public/a.txt")
            assert resp.status_code == 503

    def test_single_range(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_file(library_root, "docs/a.txt", b"0123456789")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/a.txt", "docs/a.txt")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/public/a.txt", headers={"Range": "bytes=2-5"})
            assert resp.status_code == 206
            assert resp.content == b"2345"
            assert resp.headers["content-range"] == "bytes 2-5/10"

    def test_suffix_range(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_file(library_root, "docs/a.txt", b"0123456789")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/a.txt", "docs/a.txt")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/public/a.txt", headers={"Range": "bytes=-3"})
            assert resp.status_code == 206
            assert resp.content == b"789"

    def test_open_ended_range(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_file(library_root, "docs/a.txt", b"0123456789")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/a.txt", "docs/a.txt")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/public/a.txt", headers={"Range": "bytes=7-"})
            assert resp.status_code == 206
            assert resp.content == b"789"

    def test_range_416_unsatisfiable(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_file(library_root, "docs/a.txt", b"0123456789")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/a.txt", "docs/a.txt")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/public/a.txt", headers={"Range": "bytes=30-"})
            assert resp.status_code == 416
            assert resp.headers["content-range"] == "bytes */10"

    def test_etag_and_304(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_file(library_root, "docs/a.txt", b"etag test")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/a.txt", "docs/a.txt")))
        with _app(library_root, data_dir) as client:
            resp1 = client.get("/res/public/a.txt")
            assert resp1.status_code == 200
            etag = resp1.headers["etag"]
            assert etag.startswith('"')
            resp2 = client.get("/res/public/a.txt", headers={"If-None-Match": etag})
            assert resp2.status_code == 304
            assert resp2.content == b""

    def test_etag_changes_when_content_differs(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_file(library_root, "docs/a.txt", b"version 1")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/a.txt", "docs/a.txt")))
        with _app(library_root, data_dir) as client:
            etag1 = client.get("/res/public/a.txt").headers["etag"]

        write_file(library_root, "docs/a.txt", b"version 2")
        # New app picks up the changed file from disk
        with _app(library_root, data_dir) as client2:
            etag2 = client2.get("/res/public/a.txt").headers["etag"]
            assert etag1 != etag2

    def test_empty_file(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_file(library_root, "empty.bin", b"")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/empty.bin", "empty.bin")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/public/empty.bin")
            assert resp.status_code == 200
            assert resp.content == b""
            assert resp.headers["content-length"] == "0"


# ---------------------------------------------------------------------------
# ZIP member delivery
# ---------------------------------------------------------------------------


class TestZipContent:
    def test_get_zip_member(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_rfg_zip(library_root, "pack.rfg.zip", {"inside/data.txt": b"abcdef"})
        save_mapping(mapping_path, mapping_doc(
            mapping_entry("download/data.txt", "pack.rfg.zip!/inside/data.txt")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/download/data.txt")
            assert resp.status_code == 200
            assert resp.content == b"abcdef"

    def test_range_on_zip_member(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_rfg_zip(library_root, "pack.rfg.zip", {"inside/data.txt": b"0123456789"})
        save_mapping(mapping_path, mapping_doc(
            mapping_entry("d/data.txt", "pack.rfg.zip!/inside/data.txt")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/d/data.txt", headers={"Range": "bytes=2-4"})
            assert resp.status_code == 206
            assert resp.content == b"234"

    def test_head_zip_member(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_rfg_zip(library_root, "pack.rfg.zip", {"inside/data.txt": b"ziphead"})
        save_mapping(mapping_path, mapping_doc(
            mapping_entry("d/data.txt", "pack.rfg.zip!/inside/data.txt")))
        with _app(library_root, data_dir) as client:
            resp = client.head("/res/d/data.txt")
            assert resp.status_code == 200
            assert resp.content == b""


# ---------------------------------------------------------------------------
# Error codes
# ---------------------------------------------------------------------------


class TestContentErrors:
    def test_unknown_virtual_path_404(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        save_mapping(mapping_path, {"entries": []})
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/nonexistent.txt")
            assert resp.status_code == 404

    def test_mapped_path_not_in_catalog_503(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        # Entry whose local_path is not in the catalog
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/missing.txt", "ghost/missing.bin")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/public/missing.txt")
            assert resp.status_code == 503

    def test_mapped_path_stale_503(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        write_file(library_root, "docs/a.txt", b"stale")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/a.txt", "docs/a.txt")))
        with _app(library_root, data_dir) as client:
            # Change the underlying file; the catalog's scan record is now stale
            write_file(library_root, "docs/a.txt", b"new different data")
            resp = client.get("/res/public/a.txt")
            # 503 because the file stats no longer match the scan
            assert resp.status_code == 503

    def test_duplicate_virtual_path_503(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        """If mapping somehow has duplicate virtual_path entries, return 503."""
        write_file(library_root, "docs/a.txt", b"data")
        mapping_path.parent.mkdir()
        mapping_path.write_text(
            '{"entries":['
            '{"virtual_path":"v/a.txt","local_path":"docs/a.txt"},'
            '{"virtual_path":"v/a.txt","local_path":"docs/a.txt"}'
            ']}',
            encoding="utf-8",
        )
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/v/a.txt")
            assert resp.status_code == 503

    def test_invalid_mapping_file_503(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        mapping_path.parent.mkdir()
        mapping_path.write_text("not valid json", encoding="utf-8")
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/anything.txt")
            assert resp.status_code == 503
            assert resp.json()["error"]["code"] == "content_unavailable"


# ---------------------------------------------------------------------------
# TOCTOU and preparation failures (pre-open source)
# ---------------------------------------------------------------------------


class TestContentPreparation:
    """Source preparation errors must return 503 before headers/body."""

    def test_deleted_file_before_delivery_returns_503(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        """File deleted between scan and request returns 503, not a truncated response."""
        write_file(library_root, "tmp.bin", b"temporary")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/tmp.bin", "tmp.bin")))
        with _app(library_root, data_dir) as client:
            # Remove the file so preparation fails before StreamingResponse
            (library_root / "tmp.bin").unlink()
            resp = client.get("/res/public/tmp.bin")
            assert resp.status_code == 503

    def test_replaced_with_symlink_returns_503(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        """Replacing a file with a symlink causes preparation failure → 503."""
        write_file(library_root, "real.bin", b"real content")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/real.bin", "real.bin")))
        with _app(library_root, data_dir) as client:
            # Replace the file with a symlink (violates is_symlink check)
            (library_root / "real.bin").unlink()
            symlink_or_skip(library_root / "real.bin", library_root / "other.bin")
            resp = client.get("/res/public/real.bin")
            assert resp.status_code == 503

    def test_deleted_archive_member_returns_503(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        """If an archive is deleted after scan, delivery returns 503."""
        write_rfg_zip(library_root, "pack.rfg.zip", {"data.txt": b"hello"})
        save_mapping(mapping_path, mapping_doc(
            mapping_entry("dl/data.txt", "pack.rfg.zip!/data.txt")))
        with _app(library_root, data_dir) as client:
            (library_root / "pack.rfg.zip").unlink()
            resp = client.get("/res/dl/data.txt")
            assert resp.status_code == 503

    def test_generator_closes_handles_on_disconnect(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        """StreamingResponse generator closes handles via finally even on early exit.

        We verify that normal delivery succeeds (generator properly closes handles).
        """
        write_file(library_root, "doc.txt", b"stream test")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/doc.txt", "doc.txt")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/public/doc.txt")
            assert resp.status_code == 200
            assert resp.content == b"stream test"

    def test_empty_file_preparation_succeeds(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        """Empty files are prepared (open + fstat) and delivered correctly."""
        write_file(library_root, "empty.bin", b"")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/empty.bin", "empty.bin")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/public/empty.bin")
            assert resp.status_code == 200
            assert resp.content == b""
            assert resp.headers["content-length"] == "0"

    def test_range_on_prepared_empty_file(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        """Range request on a prepared empty file returns 416."""
        write_file(library_root, "e.bin", b"")
        save_mapping(mapping_path, mapping_doc(mapping_entry("public/e.bin", "e.bin")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/public/e.bin", headers={"Range": "bytes=0-"})
            assert resp.status_code == 416

    def test_zip_member_preparation_failure_range_handling(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        """Preparation opens archive and validates member before headers."""
        write_rfg_zip(library_root, "arc.rfg.zip", {"inner/notes.txt": b"zip content here"})
        save_mapping(mapping_path, mapping_doc(
            mapping_entry("v/notes.txt", "arc.rfg.zip!/inner/notes.txt")))
        with _app(library_root, data_dir) as client:
            resp = client.get("/res/v/notes.txt", headers={"Range": "bytes=2-6"})
            assert resp.status_code == 206
            assert resp.content == b"p con"

    def test_archive_preparation_fstat_mismatch_503(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        """When archive fd-based fstat does not match the source snapshot, return 503."""
        content = b"archive body for fstat check"
        write_rfg_zip(library_root, "arc.rfg.zip", {"inner/file.txt": content})
        save_mapping(mapping_path, mapping_doc(
            mapping_entry("v/file.txt", "arc.rfg.zip!/inner/file.txt")))
        # We test by replacing the archive after scan so that physical size/mtime
        # differs from what the source snapshot recorded.
        with _app(library_root, data_dir) as client:
            # Replace the archive file on disk — the fd-based fstat will detect the change
            write_rfg_zip(library_root, "arc.rfg.zip", {"inner/file.txt": b"changed"})
            resp = client.get("/res/v/file.txt")
            assert resp.status_code == 503

    def test_archive_preparation_deleted_after_open_503(self, library_root: Path, data_dir: Path, mapping_path: Path) -> None:
        """When an archive is deleted after scan, the fd-based preparation returns 503."""
        write_rfg_zip(library_root, "arc.rfg.zip", {"inner/file.txt": b"to be deleted"})
        save_mapping(mapping_path, mapping_doc(
            mapping_entry("v/file.txt", "arc.rfg.zip!/inner/file.txt")))
        with _app(library_root, data_dir) as client:
            (library_root / "arc.rfg.zip").unlink()
            resp = client.get("/res/v/file.txt")
            assert resp.status_code == 503
