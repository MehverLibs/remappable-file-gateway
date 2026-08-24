#!/bin/sh
# Build the starter against an explicit Wheel without reading a parent project.
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    printf '%s\n' "Usage: build-local-wheel-image.sh <wheel-path> [image-tag]" >&2
    exit 2
fi

wheel_path=$1
if [ ! -f "$wheel_path" ]; then
    printf '%s\n' "Wheel file not found: $wheel_path" >&2
    exit 2
fi

wheel_dir=$(CDPATH= cd -- "$(dirname -- "$wheel_path")" && pwd)
wheel="$wheel_dir/$(basename "$wheel_path")"
image_tag=${2:-rfg-demo:local}
demo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$demo_root"
wheel_name=$(basename "$wheel")
mkdir -p .wheel-staging
trap 'rm -f -- ".wheel-staging/$wheel_name"; rmdir .wheel-staging 2>/dev/null || true' 0
cp "$wheel" ".wheel-staging/$wheel_name"
docker build -f wheel-demo-bridge/Dockerfile --build-arg "RFG_WHEEL=$wheel_name" -t "$image_tag" .
