#!/bin/sh
# Seed the Demo-owned UI into the persistent RFG data directory exactly once.
set -eu

: "${RFG_DATA_DIR:?RFG_DATA_DIR must be set}"
frontend_dir="$RFG_DATA_DIR/index"

if [ ! -f "$frontend_dir/index.html" ]; then
    mkdir -p "$frontend_dir"
    cp -R /app/frontend/. "$frontend_dir/"
fi

exec python -m uvicorn backend.app:app --host 0.0.0.0 --port 8080
