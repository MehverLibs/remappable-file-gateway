#!/bin/sh
# Verify the bridge image starts, seeds its UI, and exposes its API.
set -eu

if [ "$#" -ne 1 ]; then
    printf '%s\n' "Usage: smoke-image.sh <image-tag>" >&2
    exit 2
fi

container="rfg-demo-smoke-$$"
resource_volume="rfg-demo-resource-$$"
data_volume="rfg-demo-data-$$"
cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
    docker volume rm -f "$resource_volume" "$data_volume" >/dev/null 2>&1 || true
}
trap cleanup 0

docker volume create "$resource_volume" >/dev/null
docker volume create "$data_volume" >/dev/null
docker run -d --name "$container" -p 127.0.0.1::8080 \
    -v "$resource_volume:/resource:ro" -v "$data_volume:/rfg-data" "$1" >/dev/null
port=$(docker port "$container" 8080/tcp | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')
test -n "$port"

attempt=0
while [ "$attempt" -lt 15 ]; do
    if curl --fail --silent --show-error "http://127.0.0.1:$port/api/v1/health" >/dev/null \
        && curl --fail --silent --show-error "http://127.0.0.1:$port/" >/dev/null; then
        exit 0
    fi
    attempt=$((attempt + 1))
    sleep 1
done

docker logs "$container" || true
exit 1
