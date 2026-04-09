@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "ARGS=%*"
set "PS_ARGS="

echo.%ARGS% | findstr /I /C:"-Platform" >nul || set "PS_ARGS=%PS_ARGS% -Platform android"
echo.%ARGS% | findstr /I /C:"-BackendHost" >nul || set "PS_ARGS=%PS_ARGS% -BackendHost 0.0.0.0"
echo.%ARGS% | findstr /I /C:"-BackendPort" >nul || set "PS_ARGS=%PS_ARGS% -BackendPort 8000"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_app.ps1" %PS_ARGS% %*
if errorlevel 1 (
    echo Launcher failed with exit code %errorlevel%.
    exit /b %errorlevel%
)

endlocal
