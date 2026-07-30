@echo off
title BAW Leadsbot - Setup and Start
cd /d "%~dp0"

echo ============================================
echo   BAW Leadsbot - one-click setup and start
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed yet. Trying automatic install...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo.
        echo Automatic install failed. Opening the Node.js website -
        echo please install it there, then double-click this file again.
        start "" https://nodejs.org
        pause
        exit /b 1
    )
    echo.
    echo Node.js installed. Please CLOSE this window and
    echo double-click setup-windows.bat ONE more time.
    pause
    exit /b 0
)

echo Node.js found:
node --version
echo.

if not exist node_modules (
    echo Installing dependencies - first time only...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo npm install failed. Check your internet connection and retry.
        pause
        exit /b 1
    )
)

echo.
echo Starting the bot... a browser tab will open at http://localhost:3000
echo Captured Rasayel messages will appear at http://localhost:3000/payloads
echo Keep this window OPEN while the bot runs. Press Ctrl+C to stop it.
echo.
start "" http://localhost:3000
call npm start
pause
