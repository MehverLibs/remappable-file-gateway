# RFG starter

Copy this directory's contents into a new project root. It is a standalone host and frontend starter that installs `remappable-file-gateway==1.0.0` from PyPI. The Wheel supplies the API; this project owns server startup and UI hosting. The default local and Docker paths require that pinned version to be published; use `wheel-demo-bridge/` before its first PyPI release.

## Local setup

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
(
  cd frontend
  corepack enable
  pnpm install --frozen-lockfile
  pnpm run build
)
```

Set `RFG_RESOURCE_PATH` to an existing resource directory and `RFG_DATA_DIR` to a writable data root. Seed the built UI only when `index/index.html` is absent, then start the host. For example:

```sh
export RFG_RESOURCE_PATH=/absolute/path/to/resources
export RFG_DATA_DIR=/absolute/path/to/data
if [ ! -f "$RFG_DATA_DIR/index/index.html" ]; then
  mkdir -p "$RFG_DATA_DIR/index"
  cp -R frontend/dist/. "$RFG_DATA_DIR/index/"
fi
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8080
```

## Containers

Choose two host directories before starting the container:

| Host directory | Compose variable | Container path | Purpose |
| --- | --- | --- | --- |
| Existing resource directory | `RFG_RESOURCE_HOST_PATH` | `/resource:ro` | Files RFG exposes through `/res/...` |
| Writable data directory | `RFG_DATA_HOST_PATH` | `/rfg-data` | Mapping state and the Demo UI seed |

Copy `.env.example` to `.env`, then set those two variables. Relative paths are relative to this starter directory. On Windows, use a Docker Desktop-compatible absolute path such as `C:/RFG/resources`. Create both directories first; the resource directory must already exist and the data directory must be writable.

```dotenv
RFG_RESOURCE_HOST_PATH=C:/RFG/resources
RFG_DATA_HOST_PATH=C:/RFG/data
```

Compose mounts the paths at startup as `/resource:ro` and `/rfg-data`. The image sets `RFG_RESOURCE_PATH=/resource` and `RFG_DATA_DIR=/rfg-data`, so the backend passes those container paths to the Wheel. Start it with:

```sh
docker compose up --build
```

The Dockerfiles declare no Docker volumes. Compose always starts the Demo with the two selected host bind mounts: `/resource:ro` for resources and `/rfg-data` for business data. The resource path is deliberately read-only.

Host updates under the resource directory become visible to the container immediately. RFG uses a catalog snapshot, so call `GET /api/v1/meta/local` (the Demo's **Refresh local directory** action) after resource changes before mapping, hashing, or serving newly added paths. The container seeds its built UI once and never overwrites an existing `index/index.html`.

## Data responsibilities

`data/` is ignored convenience storage. `data/res/` and `data/data/` are the suggested Compose sources, not required RFG locations.

```
<resource root>                 RFG_RESOURCE_PATH (read-only input)
<data root>                     RFG_DATA_DIR
  index/index.html              Demo-owned static UI, served at / and /index.html
  rfg/mapping.json              the only file written by RFG
```

The Wheel never serves the UI. The host serves `index/index.html` from the same data root that RFG uses for `rfg/mapping.json`; API and documentation routes take precedence. To upgrade a persisted UI, delete `<data>/index/index.html` before starting.

## Testing and local Wheel verification

After completing Local setup, install test tools without changing the fixed runtime dependency, then run:

```sh
python -m pip install -r requirements-test.txt
python -m pytest -q -o pythonpath= tests
cd frontend && pnpm test && pnpm run build
```

For an explicit local Wheel instead of PyPI, see [`wheel-demo-bridge/README.md`](wheel-demo-bridge/README.md). Its explicit artifact helpers work anywhere; its one-step Windows script builds this repository's Wheel before installing it.
