@echo off
title BAW Leadsbot - Sync ad attribution from conversations
cd /d "%~dp0"
node scripts\sync-ad-conversations.js %1
echo.
pause
