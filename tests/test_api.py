"""API factory integration tests excluding UI hosting."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from conftest import mapping_doc, mapping_entry, save_mapping, symlink_or_skip, write_file
from rfg.api import create_app
from rfg.auth import AllowAllAuthorizer, AuthorizationDenied, Scope


class DenyAllAuthorizer:
    def authorize(self, request: Request, scope: str) -> bool:
        raise HTTPException(status_code=403, detail=f"denied {scope}")


class PolicyDenyAuthorizer:
    def __bool__(self) -> bool:
        return False

    def authorize(self, request: Request, scope: str) -> bool:
        raise AuthorizationDenied(f"denied {scope}")


@pytest.fixture
def client(library_root: Path, data_dir: Path, mapping_path: Path) -> TestClient:
    save_mapping(mapping_path, {"entries": []})
    write_file(library_root, "a.txt", b"data")
    with TestClient(create_app(library_root, data_dir, authorizer=AllowAllAuthorizer())) as test_client:
        yield test_client


def test_health_and_unhosted_root(client: TestClient) -> None:
    assert client.get("/api/v1/health").json()["status"] == "ok"
    assert client.get("/").status_code == 404
    assert client.get("/index.html").status_code == 404


def test_mapping_etag_and_conditional_write(client: TestClient) -> None:
    first = client.get("/api/v1/meta/map")
    assert first.status_code == 200
    assert client.put("/api/v1/meta/map", json=mapping_doc(mapping_entry("v/a", "a.txt")), headers={"If-Match": first.headers["etag"]}).status_code == 200
    assert client.put("/api/v1/meta/map", json={"entries": []}, headers={"If-Match": '"wrong"'}).status_code == 412


def test_authorizer_is_injected(library_root: Path, data_dir: Path) -> None:
    with TestClient(create_app(library_root, data_dir, authorizer=DenyAllAuthorizer())) as client:
        assert client.get("/api/v1/health").status_code == 200
        assert client.get("/api/v1/meta/local").status_code == 403


def test_authorizer_can_raise_public_denial(library_root: Path, data_dir: Path) -> None:
    with TestClient(create_app(library_root, data_dir, authorizer=PolicyDenyAuthorizer())) as client:
        response = client.get("/api/v1/meta/local")
    assert response.status_code == 403
    assert response.json() == {"detail": f"denied {Scope.META_READ}"}


def test_invalid_authorizer_fails_when_creating_app(library_root: Path, data_dir: Path) -> None:
    with pytest.raises(TypeError, match="must expose authorize"):
        create_app(library_root, data_dir, authorizer=object())


def test_resource_root_keyword_is_public_factory_parameter(library_root: Path, data_dir: Path) -> None:
    with TestClient(create_app(resource_root=library_root, data_directory=data_dir)) as client:
        assert client.get("/api/v1/health").status_code == 200


def test_excessively_nested_mapping_can_be_recovered(library_root: Path, data_dir: Path, mapping_path: Path) -> None:
    mapping_path.parent.mkdir()
    nesting = sys.getrecursionlimit() + 100
    mapping_path.write_text("[" * nesting + "]" * nesting, encoding="utf-8")
    with TestClient(create_app(library_root, data_dir)) as client:
        assert client.get("/api/v1/meta/map").status_code == 503
        assert client.put("/api/v1/meta/map", json={"entries": []}, headers={"If-Match": '"anything"'}).status_code == 200
        assert client.get("/api/v1/meta/map").json() == {"entries": []}


def test_rfg_directory_symlink_is_rejected(library_root: Path, data_dir: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    symlink_or_skip(data_dir / "rfg", outside, target_is_directory=True)
    with pytest.raises(ValueError, match="must not be a symlink"):
        create_app(library_root, data_dir)


def test_runtime_openapi_is_canonical_when_mounted(library_root: Path, data_dir: Path) -> None:
    host = FastAPI()
    host.mount("/rfg", create_app(library_root, data_dir))
    with TestClient(host) as client:
        schema = client.get("/rfg/openapi.json").json()
        assert schema["servers"] == [{"url": "./"}]
        assert "/api/v1/hashes" in schema["paths"]
        assert "422" not in schema["paths"]["/api/v1/hashes"]["post"]["responses"]
        assert "image_too_large" in schema["components"]["schemas"]["HashFailed"]["properties"]["code"]["enum"]
        assert "configured pixel limit" not in str(schema)
