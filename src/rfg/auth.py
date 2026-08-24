"""Injectable authorization seam. The production default intentionally permits all."""
from __future__ import annotations
from typing import Final, Protocol
from fastapi import HTTPException, Request


class AuthorizationDenied(Exception):
    """Raise this from an injected authorizer to return a 403 response."""

    def __init__(self, detail: str = "forbidden") -> None:
        super().__init__(detail)


class Scope:
    """Stable authorization-scope names used by RFG routes."""

    META_READ: Final = "meta:read"
    META_WRITE: Final = "meta:write"
    HASHES_COMPUTE: Final = "hashes:compute"
    RESOURCE_READ: Final = "resource:read"

class Authorizer(Protocol):
    def authorize(self, request: Request, scope: str) -> bool: ...

class AllowAllAuthorizer:
    def authorize(self, request: Request, scope: str) -> bool:
        return True

def require(scope: str):
    def dependency(request: Request) -> None:
        try:
            permitted = request.app.state.authorizer.authorize(request, scope)
        except AuthorizationDenied as error:
            raise HTTPException(status_code=403, detail=str(error)) from error
        except HTTPException:
            raise
        except Exception as error:
            raise HTTPException(status_code=403, detail="forbidden") from error
        if permitted is not True:
            raise HTTPException(status_code=403, detail="forbidden")
    return dependency
