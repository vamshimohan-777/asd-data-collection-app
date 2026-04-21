@echo off
echo Generating offline bundle...
cd /d "%~dp0"

:: Ensure the assets directory exists
if not exist "android\app\src\main\assets" mkdir "android\app\src\main\assets"

:: Run the bundle command
call npx -y react-native bundle --platform android --dev false --entry-file index.android.js --bundle-output android/app/src/main/assets/index.android.bundle --assets-dest android/app/src/main/res

if %ERRORLEVEL% equ 0 (
    echo Bundle generation successful!
    echo.
    echo Please run the following command to bridge your USB connection:
    echo adb reverse tcp:8081 tcp:8081
    echo.
    echo Then reload your app on the phone.
) else (
    echo Bundle generation failed. Check for JavaScript errors.
)
pause
