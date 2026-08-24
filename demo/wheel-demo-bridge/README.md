# Local Wheel bridge

This optional bridge verifies the current repository's RFG Wheel with this
starter. The default `Dockerfile` and Compose setup install the fixed PyPI
dependency instead.

`install-local-wheel-and-build-image.bat` is the one-step Windows path. It
locates the repository root relative to this directory, builds one Wheel from
that source, installs it into the Demo, and builds a bridge image. Its optional
argument is only the image tag:

```bat
wheel-demo-bridge\install-local-wheel-and-build-image.bat
wheel-demo-bridge\install-local-wheel-and-build-image.bat rfg-demo:local
```

`install-local-wheel.bat <wheel-path>` remains an explicit-artifact helper for
CI or an already-built Wheel. The one-step command removes its temporary
`.wheel-output` and `.wheel-staging` directories after completion.

`clean.bat` removes regenerated Demo files (`.venv`, `.wheel-staging`, Python
caches, frontend dependencies, and the frontend build). It deliberately keeps
`data/` and `.env`.

For POSIX automation, `build-local-wheel-image.sh <wheel-path> [image-tag]`
builds the same local-Wheel image without accessing a parent project.
`smoke-image.sh <image-tag>` starts an image with empty temporary resource and
data roots, then verifies health, UI seeding, and the root page.
