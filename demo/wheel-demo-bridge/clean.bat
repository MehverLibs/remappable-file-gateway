echo on
setlocal EnableExtensions
cd /d "%~dp0\.."
if exist ".venv" rmdir /s /q ".venv"
if exist ".wheel-staging" rmdir /s /q ".wheel-staging"
if exist "wheel-demo-bridge\.wheel-output" rmdir /s /q "wheel-demo-bridge\.wheel-output"
if exist ".pytest_cache" rmdir /s /q ".pytest_cache"
if exist "frontend\node_modules" rmdir /s /q "frontend\node_modules"
if exist "frontend\dist" rmdir /s /q "frontend\dist"
for /d /r . %%D in (__pycache__) do if exist "%%D" rmdir /s /q "%%D"
echo Cleaned regenerated Demo files. data and .env were preserved.
if not defined RFG_SKIP_PAUSE pause
endlocal & exit /b 0
