"""Stable RFG API contract.
 
Public routes are /api/v1/health, /api/v1/meta/local, /api/v1/meta/map,
/api/v1/hashes, and GET/HEAD /res/{virtual_path}.  `create_app(resource_root,
data_directory, authorizer=...)` is the public factory.
 
.. rubric:: Optimistic concurrency for mapping
 
``GET /api/v1/meta/map`` returns an ``ETag`` derived from the canonical mapping
bytes.  ``PUT /api/v1/meta/map`` may include an ``If-Match`` header; when
present and the value does not match the current ETag the server responds
``412 Precondition Failed``.  Omitted ``If-Match`` preserves single-user
last-write-wins semantics.  Read / compare / write is serialised in-process.
 
.. rubric:: Mapping recovery
 
If the on-disk mapping file is corrupt (cannot be parsed), a valid ``PUT``
atomically replaces it regardless of an optional ``If-Match`` header.  When the
existing document is valid the standard quoted-ETag comparison applies.
"""
from __future__ import annotations
import hashlib
import json
import threading
from contextlib import asynccontextmanager
from importlib.resources import files
from pathlib import Path
from typing import Any
from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
import yaml
from . import __version__
from .auth import AllowAllAuthorizer, Authorizer, Scope, require
from .catalog import CatalogSnapshot, scan
from .content import response as resource_response
from .mapping import load, save
from .hashes import HASH_ALGORITHMS, HashError, compute_hash, hash_profile
from .mapping import safe_path

def _mapping_etag(document: dict) -> str:
    """Quoted ETag over the canonical JSON bytes of *document*."""
    payload = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return '"' + hashlib.sha256(payload).hexdigest() + '"'


_HASH_CAPACITY = 4


def create_app(resource_root: str | Path, data_directory: str | Path, *, authorizer: Authorizer | None = None) -> FastAPI:
    root, data_dir = Path(resource_root).resolve(), Path(data_directory).resolve()
    if not root.is_dir(): raise ValueError("resource_root must be an existing directory")
    if not data_dir.is_dir(): raise ValueError("data_directory must be an existing directory")
    if authorizer is not None and not callable(getattr(authorizer, "authorize", None)):
        raise TypeError("authorizer must expose authorize(request, scope) -> bool")
    rfg_data_dir = data_dir / "rfg"
    if rfg_data_dir.is_symlink(): raise ValueError("data_directory/rfg must not be a symlink")
    mapping_path = rfg_data_dir / "mapping.json"
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        with app.state.catalog_lock:
            app.state.catalog_snapshot = scan(root)
        yield
    # The canonical schema supplies its own relative server. Avoid FastAPI adding
    # a mount-specific absolute server ahead of it at /openapi.json.
    app = FastAPI(title="RemappableFileGateway", version=__version__, lifespan=lifespan, root_path_in_servers=False)
    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, _error: RequestValidationError) -> JSONResponse:
        """The public API treats malformed JSON as an invalid body, not a 422."""
        return JSONResponse({"detail": "invalid request body"}, status_code=400)
    app.state.root, app.state.mapping_path = root, mapping_path
    app.state.catalog_snapshot = CatalogSnapshot({})
    app.state.catalog_lock = threading.Lock()
    app.state.mapping_lock = threading.Lock()
    app.state.authorizer = authorizer if authorizer is not None else AllowAllAuthorizer()
    app.state.hash_capacity = threading.BoundedSemaphore(_HASH_CAPACITY)
    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            packaged_schema = files("rfg").joinpath("openapi.yaml")
            # Wheels carry this package resource. The source checkout intentionally
            # keeps one canonical file under docs/ for development and tests.
            if packaged_schema.is_file():
                schema_text = packaged_schema.read_text(encoding="utf-8")
            else:
                schema_text = (Path(__file__).resolve().parents[2] / "docs" / "api" / "openapi.yaml").read_text(encoding="utf-8")
            schema = yaml.safe_load(schema_text)
            if not isinstance(schema, dict):
                raise RuntimeError("packaged OpenAPI schema is invalid")
            app.openapi_schema = schema
        return app.openapi_schema
    app.openapi = openapi
    def mapping_snapshot() -> dict:
        try:
            return load(mapping_path)
        except ValueError as error:
            raise HTTPException(503, "mapping file is invalid") from error
    @app.get("/api/v1/health")
    def health() -> dict[str, str]: return {"status": "ok", "product": "RemappableFileGateway"}
    @app.get("/api/v1/meta/local", dependencies=[Depends(require(Scope.META_READ))])
    def local() -> dict[str, list[dict[str, int | str]]]:
        with app.state.catalog_lock:
            snapshot = scan(root)
            app.state.catalog_snapshot = snapshot
        return {"local_files": [{"local_path": path, "size_bytes": source.size} for path, source in snapshot.sources.items()]}
    @app.get("/api/v1/meta/map", dependencies=[Depends(require(Scope.META_READ))])
    def get_map() -> Response:
        document = mapping_snapshot()
        etag = _mapping_etag(document)
        return JSONResponse(document, headers={"ETag": etag})
    @app.put("/api/v1/meta/map", dependencies=[Depends(require(Scope.META_WRITE))])
    def put_map(request: Request, body: Any = Body(...)) -> dict:
        if_match = request.headers.get("if-match")
        with app.state.mapping_lock:
            if if_match is not None:
                try:
                    current = load(mapping_path)
                except ValueError:
                    # Mapping file is corrupt; allow atomic recovery
                    # regardless of the optional If-Match header.
                    pass
                else:
                    current_etag = _mapping_etag(current)
                    if if_match != current_etag:
                        raise HTTPException(status_code=412, detail="precondition failed")
            try:
                return save(mapping_path, body)
            except ValueError as error:
                raise HTTPException(400, str(error)) from error
            except OSError as error:
                raise HTTPException(400, "mapping persistence failed") from error
    @app.post("/api/v1/hashes", dependencies=[Depends(require(Scope.HASHES_COMPUTE))])
    def hash_file(body: Any = Body(...)) -> Response:
        if not isinstance(body, dict) or set(body) != {"local_path", "algorithm"}:
            raise HTTPException(400, "hash request must contain exactly local_path and algorithm")
        try:
            local_path = safe_path(body["local_path"], "local_path")
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        algorithm = body["algorithm"]
        if not isinstance(algorithm, str) or algorithm not in HASH_ALGORITHMS:
            raise HTTPException(400, "unsupported hash algorithm")
        source = app.state.catalog_snapshot.sources.get(local_path)
        if source is None:
            raise HTTPException(404, "local path is not in current catalog")
        if not app.state.hash_capacity.acquire(blocking=False):
            return JSONResponse({"detail": "hash capacity is unavailable", "code": "capacity_exceeded"}, status_code=429, headers={"Retry-After": "1"})
        try:
            try:
                value, code = compute_hash(root, source, algorithm)
                result = {"status": "succeeded", "value": value, "code": code, "detail": None, "error": None}
            except HashError as error:
                detail = str(error)
                result = {"status": "failed", "value": None, "code": error.code, "detail": detail,
                          "error": {"code": error.code, "message": detail, "retryable": error.code in {"source_stale", "changed_during_hash", "hash_failed"}}}
            except Exception:
                detail = "hash computation failed"
                result = {"status": "failed", "value": None, "code": "hash_failed", "detail": detail,
                          "error": {"code": "hash_failed", "message": detail, "retryable": True}}
            return JSONResponse({"local_path": local_path, "algorithm": algorithm, "profile": hash_profile(algorithm), **result})
        finally:
            app.state.hash_capacity.release()
    @app.api_route("/res/{virtual_path:path}", methods=["GET", "HEAD"], dependencies=[Depends(require(Scope.RESOURCE_READ))])
    def resource(request: Request, virtual_path: str):
        try: document = mapping_snapshot()
        except HTTPException: return JSONResponse({"error": {"code": "content_unavailable"}}, status_code=503)
        return resource_response(request, virtual_path, document, app.state.catalog_snapshot.sources, root)
    return app
