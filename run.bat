@echo off
title UGC Flow Studio
cd /d "%~dp0"

:: Matikan server lama jika masih menyala agar tidak bentrok
taskkill /f /im node.exe >nul 2>&1

SET PATH=%~dp0tools\ffmpeg\bin;%~dp0tools\node\node-v20.18.0-win-x64;%PATH%
SET NODE_EXE=%~dp0tools\node\node-v20.18.0-win-x64\node.exe
SET SERVER=%~dp0server\index.js
SET FFMPEG_PATH=%~dp0tools\ffmpeg\bin\ffmpeg.exe
SET FFPROBE_PATH=%~dp0tools\ffmpeg\bin\ffprobe.exe

echo.
echo ==========================================
echo   UGC Flow Studio - Starting Server...
echo ==========================================
echo.

IF NOT EXIST "%NODE_EXE%" (
    echo [ERROR] Node.js tidak ditemukan.
    pause
    exit /b 1
)

echo Server dimulai... Buka browser ke http://localhost:8787
echo Tekan Ctrl+C untuk menghentikan server.
echo.

start "" "http://localhost:8787"
"%NODE_EXE%" "%SERVER%"

pause
