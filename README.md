# RemappableFileGateway

RemappableFileGateway is an installable Python package with a deliberately narrow,
stable core: `rfg.api.create_app(resource_root, data_directory, *, authorizer=None)`, the
versioned HTTP API, mapping persistence at `<data>/rfg/mapping.json`, and fixed
ZIP safety limits plus Pillow-derived image protection. It does not configure a
server, read environment variables, or host a UI.

`demo/` is a copyable standalone starter with a fixed published Wheel
dependency. `demo/wheel-demo-bridge/` contains optional local Wheel tooling:
one script builds from this repository, while explicit-artifact helpers also
work after copying the starter. The Demo UI is not an API or integration contract.

The documented factory and API v1 contract are the supported integration
surface. Hosts must not depend on `app.state`, package-private modules, Demo
environment variables, or Demo UI behavior.

- [OpenAPI 3.1 schema](docs/api/openapi.yaml)
- [API companion](docs/api/contract.md)
- [Standalone demo](demo/README.md)

## Layout

```text
docs/api/          Versioned HTTP contract (OpenAPI schema and normative companion)
src/               RFG package source
tests/             Core library tests
demo/              Copyable standalone starter
  backend/         Demo host
  frontend/        Reference frontend
  tests/           Reference-host tests
  wheel-demo-bridge/ Optional local Wheel verification tools
```

## Wheel Distribution

Build a wheel from the repository root:

```sh
rm -f dist/remappable_file_gateway-*.whl
python -m pip wheel --no-deps --wheel-dir dist .
```

The wheel is written to `dist/`. Its dependencies are intentionally not bundled;
they are resolved when the downstream application installs the wheel.

Install a locally built wheel with:

```sh
python -m pip install dist/remappable_file_gateway-*.whl
```

A downstream application can lock the package to an exact version in its own
dependency file, for example:

```text
remappable-file-gateway==1.0.0
```

This repository can be configured for public PyPI publishing when its release
process is ready; it does not imply that every fork or deployment is published
there.

## Verification

No workflow runs on `push`, pull request, or a schedule. The Core and Demo
workflows are purely manual: in GitHub, open **Actions**, select a workflow,
and use **Run workflow**. The release workflow also runs its full gate when a
GitHub Release is published.

| Workflow | Run when | What it verifies |
| --- | --- | --- |
| `Core Wheel Verification` | before pushing a core-library change | Wheel contents and installed-Wheel core tests on Python 3.10 and 3.14 |
| `Demo Reference Verification` | after changing `demo/`, or when validating the starter | Demo backend, frontend, local-Wheel Docker image, and Windows bridge |
| `Release Verification And PyPI Publishing` | manually for release readiness, or automatically when a GitHub Release is published | Core Wheel Verification on Python 3.10 through 3.14 plus every Demo reference check; published releases attach the validated wheel and publish it to PyPI only after the gate passes |

`Core Wheel Verification` and `Demo Reference Verification` only verify. A
manual run of `Release Verification And PyPI Publishing` also only verifies;
it never uploads an asset or publishes. A published GitHub Release runs the
same full gate first, then attaches the validated wheel to that Release and
publishes it to PyPI only if every check passes. The Demo and release workflows
consume Docker and Windows runner time, so use the release workflow rather than
running every workflow by default.

For local checks, install a built Wheel and test dependencies before running the
core or Demo checks. Frontend checks live in `demo/frontend`: `pnpm test` and
`pnpm run build`.

### Public PyPI publishing

Before the first public release, configure a PyPI Trusted Publisher (or Pending
Publisher) for the GitHub owner and repository, workflow filename
`.github/workflows/release.yml`, and environment `pypi`. Also create and
protect the GitHub `pypi` environment with required reviewers before enabling
publishing. See the [PyPI Trusted Publisher setup documentation](https://docs.pypi.org/trusted-publishers/adding-a-publisher/).

The `pyproject.toml` version and GitHub Release tag must be the version and
`v<version>`, respectively. Create and publish (not merely draft) the GitHub
Release; after all tests pass, the workflow builds and publishes the wheel.
This uses GitHub OIDC and needs no long-lived PyPI token or secret.

### Private index publication

The separate, optional manual mechanism for a private index remains Twine.
After a private repository is prepared and the publisher is authorized, upload
the built wheel using its actual URL:

```sh
python -m twine upload --repository-url <repository-url> dist/*.whl
```

Provide credentials through Twine configuration, keyring, or environment
variables. Do not run the command until the target private index and its access
permissions are in place.

## Embed the Package

RFG is an application factory intended to be mounted by a host FastAPI
application. The host owns server startup, its own configuration,
authentication, and UI hosting. RFG accepts only the resource root, data root,
and optional authorization policy. `rfg.auth.Scope` supplies the stable scope
names passed to the policy; a policy can raise `AuthorizationDenied` to return a
403 without importing FastAPI:

```python
from pathlib import Path

from fastapi import FastAPI, Request
from rfg.api import create_app
from rfg.auth import AuthorizationDenied, Scope


class HostAuthorizer:
    def authorize(self, request: Request, scope: str) -> bool:
        # Replace this with the host's authenticated identity and policy checks.
        if request.headers.get("X-Internal-User") is None:
            raise AuthorizationDenied("authenticated host user required")
        return scope in {Scope.META_READ, Scope.META_WRITE, Scope.HASHES_COMPUTE, Scope.RESOURCE_READ}


library_root = Path("/srv/library")
data_directory = Path("/var/lib/my-host")
if not library_root.is_dir():
    raise ValueError(f"library_root must be an existing resource directory: {library_root}")
data_directory.mkdir(parents=True, exist_ok=True)

rfg_app = create_app(resource_root=library_root, data_directory=data_directory, authorizer=HostAuthorizer())
host = FastAPI()
host.mount("/rfg", rfg_app)
```

Mounting changes the public routes to `/rfg/api/v1/*`, `/rfg/res/*`, and
`/rfg/docs`. The package defaults to `AllowAllAuthorizer`, which is suitable
only for trusted local use; a production host must pass its own permission
implementation. RFG does not start Uvicorn, read environment variables, or
host a UI itself.

Image hashing captures Pillow's current default when `rfg.hashes` first imports;
RFG does not change Pillow on import and temporarily restores its process-global
setting after each locked image open. ZIP member size, total size, compression
ratio, and entry-count limits are always enforced. The wheel packages the canonical
`docs/api/openapi.yaml` as `rfg/openapi.yaml`; runtime `/openapi.json` and
`/docs` use that schema.
