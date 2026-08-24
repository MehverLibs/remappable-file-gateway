"""Standalone demo host for an installed RemappableFileGateway wheel."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi.staticfiles import StaticFiles
from rfg.api import create_app


def _required_directory(name: str, default: str, *, create: bool = False) -> Path:
    value = os.getenv(name, default)
    if value == "":
        raise RuntimeError(f"{name} must not be empty")
    path = Path(value).expanduser()
    if create:
        try:
            path.mkdir(parents=True, exist_ok=True)
        except (FileExistsError, NotADirectoryError, OSError) as error:
            raise RuntimeError(f"{name} must name a creatable directory: {path}") from error
    if not path.is_dir():
        requirement = "a creatable directory" if create else "an existing directory"
        raise RuntimeError(f"{name} must name {requirement}: {path}")
    return path.resolve()


def create_demo_app():
    """Read demo-only configuration and attach its frontend to an RFG app."""
    resource = _required_directory("RFG_RESOURCE_PATH", "/resource")
    data = _required_directory("RFG_DATA_DIR", "/rfg-data", create=True)
    frontend = data / "index"
    if not (frontend / "index.html").is_file():
        raise RuntimeError(
            f"Demo data root must contain index/index.html: {data / 'index' / 'index.html'}"
        )
    app = create_app(resource, data)
    # Added after RFG's routes, so API, resource, docs, and OpenAPI routes win.
    app.mount("/", StaticFiles(directory=frontend, html=True), name="demo-frontend")
    return app


app = create_demo_app()
