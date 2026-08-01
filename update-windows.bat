@echo off
title BAW Leadsbot - Update to latest version
cd /d "%~dp0"

set ZIPURL=https://codeload.github.com/Usama83/BAW_Leadsbot/zip/refs/heads/claude/rasayel-ad-attribution-bot-fersyw
set TMPD=%TEMP%\baw_update

echo Downloading the latest version from GitHub...
powershell -NoProfile -Command "Invoke-WebRequest -Uri '%ZIPURL%' -OutFile '%TEMP%\baw_latest.zip'"
if errorlevel 1 (
    echo Download failed - check your internet connection and try again.
    pause
    exit /b 1
)

echo Extracting...
if exist "%TMPD%" rmdir /s /q "%TMPD%"
powershell -NoProfile -Command "Expand-Archive -Path '%TEMP%\baw_latest.zip' -DestinationPath '%TMPD%' -Force"
if errorlevel 1 (
    echo Extract failed.
    pause
    exit /b 1
)

set SRC=
for /d %%D in ("%TMPD%\*") do set SRC=%%D
if not defined SRC (
    echo Could not find extracted files.
    pause
    exit /b 1
)

echo Updating files - your captured data and saved token are kept...
robocopy "%SRC%" "%~dp0." /E /XD data node_modules /XF .env >nul
if errorlevel 8 (
    echo Update failed while copying files.
    pause
    exit /b 1
)

rmdir /s /q "%TMPD%"
del "%TEMP%\baw_latest.zip"

echo.
echo ============================================
echo   Updated successfully to the latest version!
echo   Now run setup-windows.bat to start the bot,
echo   or fetch-history.bat to pull Rasayel history.
echo ============================================
pause
