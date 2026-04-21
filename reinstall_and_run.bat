@echo off
setlocal EnableExtensions

cd /d "%~dp0"
echo Reinstalling backend + mobile dependencies and launching services...
echo Closing any lingering processes to unlock files...
taskkill /F /IM node.exe /T 2>nul
taskkill /F /IM python.exe /T 2>nul
taskkill /F /IM java.exe /T 2>nul

echo Checking for Java 17...
set "JAVA_FOUND=0"
for /f "tokens=*" %%i in ('where java 2^>nul') do (
    "%%i" -version 2>&1 | findstr /I "version \"17." >nul
    if not errorlevel 1 set "JAVA_FOUND=1"
)

if "%JAVA_FOUND%"=="0" (
    echo Java 17 was not found in PATH.
    echo Attempting to install Microsoft OpenJDK 17 via winget...
    winget install --id Microsoft.OpenJDK.17 --silent --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
        echo Winget installation failed or was cancelled. 
        echo Please ensure you have JDK 17 installed and it is in your PATH.
    ) else (
        echo Java 17 installation finished.
    )
)

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
