"""The reference frontend constants must follow the canonical OpenAPI contract."""
from __future__ import annotations

import re
import tempfile
from pathlib import Path

from rfg.api import create_app


def test_frontend_constants_match_canonical_openapi() -> None:
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory() as directory:
        workspace = Path(directory)
        resource_root = workspace / "resource"
        data_root = workspace / "data"
        resource_root.mkdir()
        data_root.mkdir()
        schema = create_app(resource_root, data_root).openapi()
    frontend = (root / "frontend/src/api.ts").read_text(encoding="utf-8")

    paths = set(schema["paths"])
    api_paths_block = re.search(r"export const API_PATHS = \{(.*?)\} as const;", frontend, re.DOTALL)
    assert api_paths_block is not None
    frontend_paths = set(re.findall(r'"(/api/v1/[^\"]+)"', api_paths_block.group(1)))
    assert frontend_paths == {path for path in paths if path.startswith("/api/v1/")}

    algorithms = schema["components"]["schemas"]["HashRequest"]["properties"]["algorithm"]["enum"]
    algorithms_block = re.search(r"export const HASH_ALGORITHMS[^=]*= \[(.*?)\];", frontend, re.DOTALL)
    assert algorithms_block is not None
    assert re.findall(r'"([a-z0-9]+)"', algorithms_block.group(1)) == algorithms
