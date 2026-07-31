@echo off
title BAW Leadsbot - Fetch July history from Rasayel
cd /d "%~dp0"

if not exist .env (
    echo No .env file found - let's create one.
    echo.
    set /p TOKEN=Paste your Rasayel API token and press Enter:
    call echo RASAYEL_API_TOKEN=%%TOKEN%%> .env
    echo Saved to .env - this stays on your computer only.
    echo.
)

node scripts\fetch-history.js
echo.
pause
