@echo off
title BAW Leadsbot - Referral data check
cd /d "%~dp0"
node scripts\check-referral.js %1
echo.
pause
