@echo off
title BAW Leadsbot - Import Rasayel contacts export
cd /d "%~dp0"
node scripts\import-contacts.js %1
echo.
pause
