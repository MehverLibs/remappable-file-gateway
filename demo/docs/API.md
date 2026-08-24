# API integration

The installed RFG Wheel is the API contract source. Its running host exposes
the canonical schema at `/openapi.json` and interactive documentation at
`/docs`.

API v1 includes `GET /api/v1/health`, `GET /api/v1/meta/local`,
`GET` and `PUT /api/v1/meta/map`, `POST /api/v1/hashes`, and
`GET /res/{virtual_path}`. The host passes `RFG_RESOURCE_PATH` as the read-only
resource root and `RFG_DATA_DIR` as the data root. RFG stores mappings at
`<data root>/rfg/mapping.json`; the host serves its UI from
`<data root>/index/index.html`.

The frontend calls the API from the same origin by default. `?apiBase=` can
select another origin, optionally with a path prefix; a cross-origin base
requires deployment-provided CORS. The UI and optional local-Wheel bridge are
host tooling, not API contract.

## Container mounts

Compose maps `RFG_RESOURCE_HOST_PATH` to `/resource:ro` and
`RFG_DATA_HOST_PATH` to `/rfg-data`. The image passes those paths to the host as
`RFG_RESOURCE_PATH=/resource` and `RFG_DATA_DIR=/rfg-data`. Resource files may
change on the host while the container is running; call `GET /api/v1/meta/local`
to refresh RFG's catalog snapshot before using new or changed paths.
