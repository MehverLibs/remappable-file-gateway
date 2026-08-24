"""The demo is a host layer over the public installed/visible rfg package."""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient



def mapping_entry(virtual_path: str, local_path: str) -> dict[str, str]:
    return {"virtual_path": virtual_path, "local_path": local_path}


def mapping_doc(*entries: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    return {"entries": list(entries)}


def save_mapping(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document), encoding="utf-8")


def _load_demo_app(
    tmp_path: Path,
    monkeypatch,
    *,
    resource_path: str | Path | None = None,
    data_directory: str | Path | None = None,
    create_index: bool = True,
):
    """Build the demo host exactly as uvicorn does: env config, loaded by file path."""
    resource = tmp_path / "resource"
    data = tmp_path / "data"
    resource.mkdir()
    if create_index:
        (data / "index").mkdir(parents=True)
        (data / "index" / "index.html").write_text("<html>demo</html>", encoding="utf-8")
    monkeypatch.setenv("RFG_RESOURCE_PATH", str(resource if resource_path is None else resource_path))
    monkeypatch.setenv("RFG_DATA_DIR", str(data if data_directory is None else data_directory))
    app_file = Path(__file__).resolve().parents[1] / "backend" / "app.py"
    spec = importlib.util.spec_from_file_location("rfg_demo_test", app_file)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.create_demo_app(), resource, data


def test_demo_uses_rfg_factory_and_hosts_frontend(tmp_path: Path, monkeypatch) -> None:
    app, _resource, data = _load_demo_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        assert client.get("/api/v1/health").status_code == 200
        assert client.get("/").text == "<html>demo</html>"
        assert client.get("/index.html").text == "<html>demo</html>"
        assert client.put("/api/v1/meta/map", json=mapping_doc()).status_code == 200
    assert (data / "rfg" / "mapping.json").is_file()


def test_demo_static_mount_does_not_shadow_api_routes(tmp_path: Path, monkeypatch) -> None:
    """The "/" static mount must lose to /api/v1/health, /docs, and /res/{path}.

    Serving mapped bytes end-to-end also proves the demo wires the env-configured
    resource and data directories into create_app: the mapping is only found in
    RFG_DATA_DIR and the content only exists under RFG_RESOURCE_PATH.
    """
    app, resource, data = _load_demo_app(tmp_path, monkeypatch)
    (resource / "a.txt").write_bytes(b"demo-resource")
    save_mapping(data / "rfg" / "mapping.json", mapping_doc(mapping_entry("v/a.txt", "a.txt")))
    with TestClient(app) as client:
        assert client.get("/api/v1/health").status_code == 200
        docs = client.get("/docs")
        assert docs.status_code == 200
        assert "swagger" in docs.text.lower()
        assert client.get("/openapi.json").status_code == 200
        resource = client.get("/res/v/a.txt")
        assert resource.status_code == 200
        assert resource.content == b"demo-resource"


@pytest.mark.parametrize("variable", ["RFG_RESOURCE_PATH", "RFG_DATA_DIR"])
def test_demo_rejects_empty_directory_environment_value(tmp_path: Path, monkeypatch, variable: str) -> None:
    paths = {"resource_path": None, "data_directory": None}
    paths["resource_path" if variable == "RFG_RESOURCE_PATH" else "data_directory"] = ""
    with pytest.raises(RuntimeError, match=rf"{variable} must not be empty"):
        _load_demo_app(tmp_path, monkeypatch, **paths)


def test_demo_rejects_missing_resource_directory(tmp_path: Path, monkeypatch) -> None:
    missing_resource = tmp_path / "missing-resource"
    with pytest.raises(
        RuntimeError,
        match=rf"RFG_RESOURCE_PATH must name an existing directory: {re.escape(str(missing_resource))}",
    ):
        _load_demo_app(tmp_path, monkeypatch, resource_path=missing_resource)


def test_demo_rejects_data_path_that_is_a_regular_file(tmp_path: Path, monkeypatch) -> None:
    data_file = tmp_path / "not-a-directory"
    data_file.write_text("not a directory", encoding="utf-8")
    with pytest.raises(
        RuntimeError,
        match=rf"RFG_DATA_DIR must name a creatable directory: {re.escape(str(data_file))}",
    ):
        _load_demo_app(tmp_path, monkeypatch, data_directory=data_file)


def test_demo_requires_index_in_rfg_data_directory(tmp_path: Path, monkeypatch) -> None:
    data = tmp_path / "data"
    index = data / "index" / "index.html"
    with pytest.raises(
        RuntimeError,
        match=rf"Demo data root must contain index/index\.html: {re.escape(str(index))}",
    ):
        _load_demo_app(tmp_path, monkeypatch, create_index=False)
