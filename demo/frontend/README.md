# RFG reference client

This is a reference browser client for the API, not the API specification. Read [`../docs/API.md`](../docs/API.md) for integration guidance. The installed Wheel serves the canonical schema at `/docs` and `/openapi.json`. It may change without expanding or promising the RFG API. Its current draft and mapping workflow is reference UX only, not a contractual client protocol.

The client builds to one self-contained `dist/index.html`, calls the API from the same origin by default, and accepts `?apiBase=https://host[:port]` (optionally with a path prefix on that origin) for another API origin. A cross-origin base requires deployment-provided CORS; the RFG package does not configure it. Its source is under `src/`.

## Build and test

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run dev
```

`pnpm run dev` proxies `/api` and `/res` to `127.0.0.1:8080`. The package pins pnpm in `package.json`; direct use requires Corepack/pnpm. `dist/` is generated. `pnpm test` intentionally runs Vitest with one worker to keep jsdom memory use stable in constrained CI and Docker environments. These tests validate this reference client, not a separate RFG compatibility promise.

## Demo hosting

`dist/` is hosted by the demo backend. See [`../README.md`](../README.md) for local and Docker startup; the frontend must not write RFG mapping state directly.
