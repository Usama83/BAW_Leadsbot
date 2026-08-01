@echo off
title BAW Leadsbot - Fetch ad names from Meta
cd /d "%~dp0"

if not exist .env goto :ask
findstr /b "META_ACCESS_TOKEN=" .env >nul 2>nul
if not errorlevel 1 goto :run

:ask
echo The Meta (Facebook) access token is not saved yet.
echo.
set /p MTOKEN=Paste your META access token and press Enter:
call echo META_ACCESS_TOKEN=%%MTOKEN%%>> .env
echo Saved to .env - stays on your computer only.
echo.

:run
node scripts\fetch-ad-names.js
echo.
pause
