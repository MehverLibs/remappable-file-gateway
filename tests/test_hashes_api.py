"""Synchronous, bounded single-file hash endpoint contract."""
from __future__ import annotations

import hashlib
import threading
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
import pytest

from conftest import write_file, write_rfg_zip
from rfg.api import create_app
from rfg.auth import AllowAllAuthorizer, Scope


class ScopeAuthorizer:
    def __init__(self, allowed: str): self.allowed = allowed
    def authorize(self, request: Request, scope: str) -> bool:
        if scope == self.allowed: return True
        raise HTTPException(403, "denied")


@pytest.fixture
def client(library_root: Path, data_dir: Path) -> TestClient:
    app = create_app(library_root, data_dir, authorizer=AllowAllAuthorizer())
    with TestClient(app) as value: yield value


def test_local_catalog_is_exact_file_records_and_refreshes(client: TestClient, library_root: Path) -> None:
    write_file(library_root, "a.txt", b"one")
    assert client.get("/api/v1/meta/local").json() == {"local_files": [{"local_path": "a.txt", "size_bytes": 3}]}
    write_file(library_root, "b.txt", b"two!")
    assert client.get("/api/v1/meta/local").json() == {"local_files": [{"local_path": "a.txt", "size_bytes": 3}, {"local_path": "b.txt", "size_bytes": 4}]}


def test_hash_returns_terminal_exact_shape(client: TestClient, library_root: Path) -> None:
    write_file(library_root, "a.txt", b"hello")
    client.get("/api/v1/meta/local")
    response = client.post("/api/v1/hashes", json={"local_path": "a.txt", "algorithm": "md5"})
    assert response.status_code == 200
    assert response.json() == {"local_path": "a.txt", "algorithm": "md5", "profile": None, "status": "succeeded", "value": hashlib.md5(b"hello").hexdigest(), "code": "computed", "detail": None, "error": None}


def test_hash_compute_failure_is_terminal_200(client: TestClient, library_root: Path) -> None:
    write_file(library_root, "not-image.png", b"not image")
    client.get("/api/v1/meta/local")
    result = client.post("/api/v1/hashes", json={"local_path": "not-image.png", "algorithm": "ahash"})
    assert result.status_code == 200
    assert result.json()["status"] == "failed"
    assert result.json()["code"] == "unsupported_image"
    assert set(result.json()) == {"local_path", "algorithm", "profile", "status", "value", "code", "detail", "error"}


@pytest.mark.parametrize("body", [{}, {"local_path": "a.txt"}, {"local_path": "a.txt", "algorithm": "md5", "extra": 1}, {"local_path": "a.txt", "algorithm": "nope"}, {"local_path": "../a.txt", "algorithm": "md5"}])
def test_hash_rejects_non_exact_body(client: TestClient, body: dict) -> None:
    assert client.post("/api/v1/hashes", json=body).status_code == 400


def test_hash_requires_refreshed_catalog_and_reuses_zip_crc(client: TestClient, library_root: Path) -> None:
    write_rfg_zip(library_root, "p.rfg.zip", {"x.bin": b"x"})
    assert client.post("/api/v1/hashes", json={"local_path": "p.rfg.zip!/x.bin", "algorithm": "crc32"}).status_code == 404
    client.get("/api/v1/meta/local")
    body = client.post("/api/v1/hashes", json={"local_path": "p.rfg.zip!/x.bin", "algorithm": "crc32"}).json()
    assert body["status"] == "succeeded" and body["code"] == "reused"


def test_hash_scope_is_used(library_root: Path, data_dir: Path) -> None:
    write_file(library_root, "a.txt", b"a")
    app = create_app(library_root, data_dir, authorizer=ScopeAuthorizer(Scope.HASHES_COMPUTE))
    with TestClient(app) as client:
        assert client.get("/api/v1/meta/local").status_code == 403
        app.state.catalog_snapshot = __import__("rfg.catalog", fromlist=["scan"]).scan(library_root)
        assert client.post("/api/v1/hashes", json={"local_path": "a.txt", "algorithm": "md5"}).status_code == 200


def test_capacity_rejects_immediately(client: TestClient, library_root: Path) -> None:
    write_file(library_root, "a.txt", b"a")
    client.get("/api/v1/meta/local")
    for _ in range(4):
        assert client.app.state.hash_capacity.acquire(blocking=False)
    try:
        result = client.post("/api/v1/hashes", json={"local_path": "a.txt", "algorithm": "md5"})
    finally:
        for _ in range(4):
            client.app.state.hash_capacity.release()
    assert result.status_code == 429
    assert result.headers["retry-after"] == "1"
    assert result.json() == {"detail": "hash capacity is unavailable", "code": "capacity_exceeded"}
def test_hash_malformed_json_is_invalid_body(client: TestClient) -> None:
    assert client.post("/api/v1/hashes", content=b"{", headers={"content-type": "application/json"}).status_code == 400
