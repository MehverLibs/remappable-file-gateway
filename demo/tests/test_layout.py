from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_copyable_starter_layout() -> None:
    required = {
        "Dockerfile",
        "compose.yaml",
        "requirements.txt",
        "requirements-test.txt",
        ".dockerignore",
        ".gitignore",
        ".gitattributes",
        "docs/API.md",
        "wheel-demo-bridge/Dockerfile",
        "wheel-demo-bridge/README.md",
        "wheel-demo-bridge/build-local-wheel-image.sh",
        "wheel-demo-bridge/clean.bat",
        "wheel-demo-bridge/smoke-image.sh",
        "wheel-demo-bridge/install-local-wheel.bat",
        "wheel-demo-bridge/install-local-wheel-and-build-image.bat",
    }
    assert all((ROOT / path).is_file() for path in required)
    assert not (ROOT / "tools").exists()


def test_default_container_uses_only_starter_and_pypi() -> None:
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
    assert "context: ." in compose and "dockerfile: Dockerfile" in compose
    assert ".." not in compose and "bridge" not in compose
    for forbidden in ("pyproject", "README.md LICENSE", "COPY src", "docs/", ".wheel-staging", "RFG_WHEEL", "bridge"):
        assert forbidden not in dockerfile
    assert "VOLUME" not in dockerfile
    assert dockerfile.index("COPY backend/requirements.txt") < dockerfile.index("RUN pip install")
    requirement = (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()[0]
    assert requirement.startswith("remappable-file-gateway==")


def test_bridge_is_context_local_and_scripts_are_windows_safe() -> None:
    dockerfile = (ROOT / "wheel-demo-bridge/Dockerfile").read_text(encoding="utf-8")
    assert "COPY .wheel-staging/ /tmp/wheels/" in dockerfile
    assert "COPY ../" not in dockerfile and "pyproject" not in dockerfile and "docs/" not in dockerfile
    copy_lines = [line.strip() for line in dockerfile.splitlines() if line.startswith("COPY ")]
    assert all(
        line.startswith((
            "COPY frontend",
            "COPY .wheel-staging/",
            "COPY backend",
            "COPY entrypoint.sh",
            "COPY --from=frontend-builder",
        ))
        for line in copy_lines
    )
    for script in (ROOT / "wheel-demo-bridge").glob("*.bat"):
        content = script.read_bytes()
        lower = content.lower()
        assert b"\r\n" in content and b"\n" not in content.replace(b"\r\n", b"")
        assert content.startswith(b"echo on\r\n")
        assert b"pause" in lower and b"@" not in content and b">nul" not in lower
        assert b"goto" not in lower
        if script.name == "install-local-wheel-and-build-image.bat":
            assert b"%~dp0\\..\\.." in content
        else:
            assert b"..\\.." not in content
    install_script = (ROOT / "wheel-demo-bridge/install-local-wheel.bat").read_text(encoding="utf-8")
    image_script = (ROOT / "wheel-demo-bridge/install-local-wheel-and-build-image.bat").read_text(encoding="utf-8")
    assert "EnableDelayedExpansion" in install_script and "!PYTHON!" in install_script
    assert "EnableDelayedExpansion" in image_script and "!IMAGE_TAG!" in image_script
    assert 'set /p "RFG_WHEEL=Local wheel path: "' in install_script
    assert "!PYTHON! -m pip wheel --no-deps" in image_script
    assert "!REPO_ROOT!\\pyproject.toml" in image_script
    clean_script = (ROOT / "wheel-demo-bridge/clean.bat").read_text(encoding="utf-8").lower()
    assert "data" not in clean_script.replace("data and .env were preserved", "")
    assert "frontend\\node_modules" in clean_script and "frontend\\dist" in clean_script
    bridge_shell = (ROOT / "wheel-demo-bridge/build-local-wheel-image.sh").read_text(encoding="utf-8")
    assert ".wheel-staging" in bridge_shell and ".." not in bridge_shell.replace('"$0")/.."', "")
    smoke_shell = (ROOT / "wheel-demo-bridge/smoke-image.sh").read_text(encoding="utf-8")
    assert "/api/v1/health" in smoke_shell and "docker volume create" in smoke_shell
    assert "docker port" in smoke_shell and "docker logs \"$container\" || true" in smoke_shell


def test_starter_docs_and_ignores_are_local() -> None:
    for path in ("README.md", "docs/API.md", "frontend/README.md"):
        text = (ROOT / path).read_text(encoding="utf-8")
        assert "../../docs" not in text and "docs/api" not in text and "../dist" not in text
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8")
    for entry in ("data/", ".env", ".venv/", "frontend/node_modules/", "frontend/dist/"):
        assert entry in gitignore
    for entry in (".git", ".venv", "data", ".env", "frontend/node_modules", "frontend/dist", "tests"):
        assert entry in dockerignore
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    api_docs = (ROOT / "docs/API.md").read_text(encoding="utf-8")
    for documentation in (readme, api_docs):
        assert "RFG_RESOURCE_HOST_PATH" in documentation
        assert "RFG_DATA_HOST_PATH" in documentation
        assert "/resource:ro" in documentation
        assert "/rfg-data" in documentation
        assert "GET /api/v1/meta/local" in documentation


def test_backend_reaches_only_the_installed_package() -> None:
    backend = (ROOT / "backend/app.py").read_text(encoding="utf-8")
    assert "from rfg.api import create_app" in backend
    assert "sys.path" not in backend
