@echo off
title UGC Flow Studio
cd /d "%~dp0"

SET PATH=%~dp0tools\ffmpeg\bin;%~dp0tools\node\node-v20.18.0-win-x64;%PATH%
SET NODE_EXE=%~dp0tools\node\node-v20.18.0-win-x64\node.exe
SET SERVER=%~dp0server\index.js
SET FFMPEG_PATH=%~dp0tools\ffmpeg\bin\ffmpeg.exe
SET FFPROBE_PATH=%~dp0tools\ffmpeg\bin\ffprobe.exe

echo.
echo ==========================================
echo   UGC Flow Studio - Menjalankan Server...
echo ==========================================
echo.

taskkill /F /IM node.exe >nul 2>&1
timeout /t 1 /nobreak >nul

start "" "http://localhost:8787"
"%NODE_EXE%" "%SERVER%"

pause
