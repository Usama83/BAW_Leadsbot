@echo off
title BAW Leadsbot - Study conversations
cd /d "%~dp0"
node scripts\study-conversations.js %1
echo.
pause
