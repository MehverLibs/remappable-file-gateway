echo on
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0\.."
set "RFG_EXIT=0"
set "IMAGE_TAG=%~1"
set "REPO_ROOT=%~dp0\..\.."
set "WHEEL_OUTPUT=wheel-demo-bridge\.wheel-output"
if "!IMAGE_TAG!"=="" set "IMAGE_TAG=rfg-demo:local"
if not exist "!REPO_ROOT!\pyproject.toml" (
    echo RFG project pyproject.toml was not found: !REPO_ROOT!
    set "RFG_EXIT=1"
) else (
    if exist "!WHEEL_OUTPUT!" rmdir /s /q "!WHEEL_OUTPUT!"
    mkdir "!WHEEL_OUTPUT!"
    if errorlevel 1 (
        echo Failed to create local Wheel output directory.
        set "RFG_EXIT=1"
    ) else (
        if defined RFG_PYTHON (
            set "PYTHON=!RFG_PYTHON!"
        ) else (
            py -3 --version
            if errorlevel 1 (
                set "PYTHON=python"
            ) else (
                set "PYTHON=py -3"
            )
        )
        !PYTHON! -m pip wheel --no-deps --wheel-dir "!WHEEL_OUTPUT!" "!REPO_ROOT!"
        if errorlevel 1 (
            echo Failed to build the local RFG Wheel.
            set "RFG_EXIT=1"
        ) else (
            set "RFG_WHEEL="
            set /a RFG_WHEEL_COUNT=0
            for %%F in ("!WHEEL_OUTPUT!\*.whl") do (
                if exist "%%~fF" (
                    set /a RFG_WHEEL_COUNT+=1
                    set "RFG_WHEEL=%%~fF"
                )
            )
            if not "!RFG_WHEEL_COUNT!"=="1" (
                echo Expected exactly one local RFG Wheel, found !RFG_WHEEL_COUNT!.
                set "RFG_EXIT=1"
            ) else (
                if defined RFG_SKIP_PAUSE (
                    set "RFG_CALLER_SKIP_PAUSE=1"
                ) else (
                    set "RFG_CALLER_SKIP_PAUSE="
                )
                set "RFG_SKIP_PAUSE=1"
                call wheel-demo-bridge\install-local-wheel.bat "!RFG_WHEEL!"
                if errorlevel 1 (
                    echo Local wheel installation failed.
                    set "RFG_EXIT=1"
                ) else (
                    if exist ".wheel-staging" rmdir /s /q ".wheel-staging"
                    if exist ".wheel-staging" (
                        echo Failed to clear wheel staging.
                        set "RFG_EXIT=1"
                    ) else (
                        mkdir ".wheel-staging"
                        for %%F in ("!RFG_WHEEL!") do set "RFG_WHEEL_NAME=%%~nxF"
                        copy /y "!RFG_WHEEL!" ".wheel-staging\!RFG_WHEEL_NAME!"
                        if errorlevel 1 (
                            echo Failed to stage the local wheel.
                            set "RFG_EXIT=1"
                        ) else (
                            docker build -f wheel-demo-bridge/Dockerfile --build-arg "RFG_WHEEL=!RFG_WHEEL_NAME!" -t "!IMAGE_TAG!" .
                            if errorlevel 1 (
                                echo Docker image build failed.
                                set "RFG_EXIT=1"
                            )
                        )
                    )
                    if exist ".wheel-staging" rmdir /s /q ".wheel-staging"
                    if exist ".wheel-staging" set "RFG_EXIT=1"
                )
            )
        )
    )
)
if exist "!WHEEL_OUTPUT!" rmdir /s /q "!WHEEL_OUTPUT!"
if exist "!WHEEL_OUTPUT!" set "RFG_EXIT=1"
if defined RFG_CALLER_SKIP_PAUSE (
    set "RFG_SKIP_PAUSE=1"
) else (
    set "RFG_SKIP_PAUSE="
)
if not defined RFG_SKIP_PAUSE pause
endlocal & exit /b %RFG_EXIT%
