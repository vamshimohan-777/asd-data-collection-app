@echo off
setlocal EnableExtensions

cd /d "%~dp0"
echo Reinstalling backend + mobile dependencies and launching services...

set "PATCH_NOW=$p = Join-Path '%~dp0' 'mobile\android\gradle.properties'; if (Test-Path -LiteralPath $p) { $c = Get-Content -LiteralPath $p -Raw; $u = [regex]::Replace($c, '(?m)^reactNativeArchitectures=.*$', 'reactNativeArchitectures=arm64-v8a,x86_64'); if ($u -ne $c) { Set-Content -LiteralPath $p -Value $u -NoNewline } }"
set "PATCH_WATCH=$p = Join-Path '%~dp0' 'mobile\android\gradle.properties'; for ($i = 0; $i -lt 240; $i++) { if (Test-Path -LiteralPath $p) { $c = Get-Content -LiteralPath $p -Raw; $u = [regex]::Replace($c, '(?m)^reactNativeArchitectures=.*$', 'reactNativeArchitectures=arm64-v8a,x86_64'); if ($u -ne $c) { Set-Content -LiteralPath $p -Value $u -NoNewline } }; Start-Sleep -Milliseconds 500 }"
powershell -NoProfile -ExecutionPolicy Bypass -Command "%PATCH_NOW%"
start "" /B powershell -NoProfile -ExecutionPolicy Bypass -Command "%PATCH_WATCH%"

set "ARGS=%*"
set "PS_ARGS=-CleanInstall"

echo.%ARGS% | findstr /I /C:"-Platform" >nul || set "PS_ARGS=%PS_ARGS% -Platform android"
echo.%ARGS% | findstr /I /C:"-BackendHost" >nul || set "PS_ARGS=%PS_ARGS% -BackendHost 0.0.0.0"
echo.%ARGS% | findstr /I /C:"-BackendPort" >nul || set "PS_ARGS=%PS_ARGS% -BackendPort 8000"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_app.ps1" %PS_ARGS% %*
if errorlevel 1 (
    echo Launcher failed with exit code %errorlevel%.
    exit /b %errorlevel%
)

endlocal
