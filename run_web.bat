@echo off
echo Starting Quantum Pose Web Studio...
cd /d "%~dp0web"

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

echo.
echo Launching dev server at http://localhost:3000
echo.
npm run dev
