echo on
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0\.."
set "RFG_EXIT=0"
set "RFG_WHEEL=%~f1"
if "!RFG_WHEEL!"=="" set /p "RFG_WHEEL=Local wheel path: "
if "!RFG_WHEEL!"=="" (
    echo Usage: install-local-wheel.bat ^<wheel-path^>
    set "RFG_EXIT=1"
) else (
    for %%F in ("!RFG_WHEEL!") do set "RFG_WHEEL=%%~fF"
    if not exist "!RFG_WHEEL!" (
        echo Wheel file not found: !RFG_WHEEL!
        set "RFG_EXIT=1"
    ) else (
        if defined RFG_PYTHON (
            set "PYTHON=%RFG_PYTHON%"
        ) else (
            py -3 --version
            if errorlevel 1 (
                set "PYTHON=python"
            ) else (
                set "PYTHON=py -3"
            )
        )
        !PYTHON! -m venv --clear .venv
        if errorlevel 1 (
            echo Failed to create demo .venv.
            set "RFG_EXIT=1"
        ) else (
            .venv\Scripts\python.exe -m pip install -r backend\requirements.txt "!RFG_WHEEL!"
            if errorlevel 1 (
                echo Failed to install the local wheel.
                set "RFG_EXIT=1"
            ) else (
                .venv\Scripts\python.exe -c "import rfg; print(rfg.__file__)"
                if errorlevel 1 set "RFG_EXIT=1"
            )
        )
    )
)
if not defined RFG_SKIP_PAUSE pause
endlocal & exit /b %RFG_EXIT%
