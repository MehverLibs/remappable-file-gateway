# RFG API v1 companion

## Status and scope

This is the normative companion to [`openapi.yaml`](openapi.yaml), the canonical machine-readable API schema. It specifies API v1 for mapping a local catalog to readable virtual resources. The package implements this contract. The optional `demo/` host is non-normative and does not extend it: its UI workflow, container files, environment variables, and Windows tools are not API v1 behavior.

**Terms.** A *resource root* is the deployment-selected local directory. A *catalog* is its safe, ephemeral scan. A *local path* identifies a catalogued ordinary file or `.rfg.zip` archive member. A *virtual path* is the public mapping key. A *mapping* is the `{"entries":[...]}` document persisted by an embedding host through the package.

## General and path rules

All API bodies are JSON unless a resource response is binary. API v1 does not standardize an authorization wire protocol or token header. Deployments decide how to grant `meta:read`, `meta:write`, `hashes:compute`, and `resource:read`; a denied operation returns 403. Health is not scope-protected by the package factory.

Paths are non-empty POSIX-relative strings: no leading `/`, backslash, NUL, empty segment, `.` or `..`. `.rfg.zip` archive members are logical paths such as `archive.rfg.zip!/member/path`; clients must treat all paths as opaque values and must not infer host paths.

Most runtime validation errors use `{"detail": string}`. This is not a universal error envelope: hash computation failures are successful HTTP 200 terminal results with a structured `error`, and resource errors may be empty or have a documented JSON body.

## Catalog and mapping lifecycle

`GET /api/v1/meta/local` scans the resource root and replaces the in-memory catalog snapshot. Hash and resource requests use that snapshot; they do not scan on demand. The response lists safe ordinary files and safe members of designated `.rfg.zip` archives. Unsafe/unreadable entries are omitted.

### `.rfg.zip` is a catalog type, not a generic ZIP detector

The file name suffix, compared case-insensitively, selects the behavior. A file named `package.rfg.zip` is opened as a ZIP archive during catalog scanning. Its container is not a local-file record; each eligible member becomes a record such as `package.rfg.zip!/images/logo.png`. A corrupt archive or an archive with no eligible members contributes no ordinary container record.

Any other file name is an ordinary file, including `package.zip`, `package.tar`, or a ZIP-formatted file with no `.rfg.zip` suffix. It is catalogued once at its own path, is delivered as raw bytes, and is never expanded, inspected for ZIP safety, or assigned `!/member` paths. `size_bytes` is the physical file size for an ordinary entry and the uncompressed member size for an `.rfg.zip` member.

For `.rfg.zip` members, the scanner rejects unsafe paths, directories, encrypted members, symlinks, duplicate member names, members over 1 GiB, archives over 10,000 entries or 10 GiB uncompressed, and entries whose compression ratio exceeds 200. These limits do not cause generic `.zip` files to be unpacked.

The catalog has no revision or persistence, so a client should refresh it before mapping or hashing after source changes.

The mapping is exactly `{ "entries": [...] }`. Every entry requires unique `virtual_path` and unique `local_path`; only the optional metadata fields listed in OpenAPI are allowed. Optional `size_bytes` is non-negative or null; optional hash fields are non-empty strings or null. PUT validates, normalizes, and atomically replaces the entire document; it does not require that a local path currently exists in the catalog.

GET mapping returns a quoted ETag over canonical JSON. Send that exact value as `If-Match` to avoid overwriting a changed valid mapping; mismatch is 412. Omitting it is last-write-wins. Read/compare/write is serialized only inside one process. A corrupt mapping yields 503 on GET; a valid PUT can atomically recover it even with `If-Match` present.

## Hashes

POST `/api/v1/hashes` accepts **exactly** `local_path` and `algorithm`. Algorithms are `crc32`, `md5`, `sha256`, `ahash`, `dhash`, and `phash`. CRC32 for a ZIP member of a designated `.rfg.zip` archive is reused from its validated ZIP metadata (`code: reused`); otherwise values are computed. Thus an ordinary `package.zip` receives a raw-byte CRC32 with `code: computed`, while `package.rfg.zip!/member` can receive `code: reused`. Image hashes use profile `imagehash-8-v1`; non-image algorithms have a null profile.

Accepted requests return 200 in a terminal `succeeded` or `failed` state. A failure has `value: null` and `error: {code,message,retryable}`; retryability is only advisory. Bad input is 400, an absent snapshot path is 404, and denied access is 403. The capacity semaphore has a fixed conservative capacity of 4. When full, no work starts: 429 includes `Retry-After: 1`.

Image hashing captures Pillow's current default when `rfg.hashes` first imports. RFG does not mutate Pillow on import, temporarily restores its process-global setting after each locked open, and provides no HTTP or factory parameter to override this limit. Images over it return the terminal, non-retryable `image_too_large` failure code.

## Resource delivery

GET and HEAD `/res/{virtual_path}` expose only a mapped source that exists in the current catalog snapshot. Responses provide `ETag`, `Cache-Control: no-cache`, `Accept-Ranges: bytes`, and `X-Content-Type-Options: nosniff`; content type is inferred from the virtual path or is `application/octet-stream`. Exact `If-None-Match` produces 304 before range processing. One byte range is supported and yields 206; malformed, multiple, or unsatisfiable ranges yield 416 with `Content-Range: bytes */<total>`. HEAD has the same status and headers, no body.

An unmapped virtual path is 404 with an empty body. Missing/stale snapshot sources or source preparation failures are 503 (usually empty); an unreadable mapping returns the documented `content_unavailable` JSON body. ETags are snapshot/source facts, not immutable content-version promises.

## Consistency, capacity, and security limits

The package factory keeps catalog, locks, and hash capacity in process. It has no distributed coordination, durable catalog revision, cross-process mapping lock, or multi-node consistency guarantee. Source identity is checked while hashing/delivering where possible, so races can produce terminal hash failures or 503 rather than serving a newly changed source. ZIP scanning, hashing, and delivery always apply fixed safety limits (10,000 entries; 1 GiB/member; 10 GiB total uncompressed; compression ratio 200) and skip unsafe entries.

Embedding hosts are responsible for startup, path configuration, UI hosting, authentication/authorization integration, TLS, network exposure, CORS policy, tenant isolation, quotas, logging, backups, and data retention. The package has no standardized auth protocol and no CORS configuration. It is intentionally local and in-process, without multi-tenant or hosted-service capabilities.

## Non-goals

This API does not define user management, token issuance, object uploads, database/query APIs, background job polling, catalog revisions, multi-range responses, or a generic error envelope. UI routes and server startup are not part of public API v1.

## Implementation notes (informative)

This section documents package reliability measures. It is explanatory only: the implementation does not add API v1 fields, routes, authorization headers, or persistence semantics beyond the contract above.

### Package reliability measures

- The factory owns only `<data_directory>/rfg/mapping.json`. A missing `rfg/` reads as an empty mapping and is created only by a valid mapping PUT. It rejects symbolic links for `rfg/` and the mapping file so state cannot escape the selected data root. A host may use unrelated data paths independently.
- Catalog scans skip symlinks and unsafe local paths, walk directories without following links, and keep an ephemeral, in-memory snapshot. Archive members receive the additional `.rfg.zip` checks described above.
- Mapping replacement validates the exact document shape, enforces one-to-one `virtual_path` and `local_path` values, writes a temporary file, fsyncs it, and atomically replaces `rfg/mapping.json`. GET supplies a canonical-document ETag; callers needing conflict detection should send it back in `If-Match`.
- Hash and delivery work verify source identity from the catalog before use. Streamed hash algorithms verify again after streaming, so a changed source becomes an explicit terminal failure rather than a silently mixed result. For resource GET and HEAD responses that select content (200 or 206), the factory prepares and validates the source before successful response headers are sent; preparation failure becomes 503 instead of a partial response. Conditional 304 and invalid-range 416 responses are decided from catalog facts without opening the source.
- Resource bodies stream in bounded chunks and always close ordinary-file or ZIP handles. Image hashing spools payloads to disk beyond its memory threshold, serializes large decodes, and reports decoder, storage, and resource failures as terminal hash results rather than crashing the request.
- Hash capacity is a non-blocking, in-process semaphore. It protects the factory from accepting unbounded work but is neither a distributed queue nor durable job system.
