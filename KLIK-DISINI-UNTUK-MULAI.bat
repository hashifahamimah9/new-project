@echo off
setlocal
title UGC Flow Studio
cd /d "%~dp0"

echo.
echo ==========================================
echo   UGC Flow Studio - Menyiapkan server...
echo ==========================================
echo.

rem --- Buat .env dari contoh kalau belum ada ---
if not exist ".env" if exist ".env.example" copy /y ".env.example" ".env" >nul

rem --- Baca PORT dari .env (default 8787) ---
set "PORT=8787"
if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="PORT" for /f "tokens=1" %%P in ("%%B") do set "PORT=%%P"

rem --- Cari Node.js: portable di tools\node dulu, lalu yang terpasang di sistem ---
set "NODE_EXE="
if exist "%~dp0tools\node\node.exe" set "NODE_EXE=%~dp0tools\node\node.exe"
if not defined NODE_EXE for /d %%D in ("%~dp0tools\node\node-*") do if exist "%%~fD\node.exe" set "NODE_EXE=%%~fD\node.exe"
if not defined NODE_EXE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"

rem --- Node.js wajib versi 18 ke atas (versi lama diganti Node.js portable) ---
if defined NODE_EXE "%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=18?0:1)" >nul 2>&1
if defined NODE_EXE if errorlevel 1 (
	echo [INFO] Node.js di komputer ini terlalu lama, butuh versi 18 atau lebih baru.
	set "NODE_EXE="
)

set "SETUP_DONE="
if not defined NODE_EXE (
	echo [INFO] Node.js belum ada. Mengunduh Node.js dan FFmpeg portable, tunggu sebentar...
	powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-and-run.ps1" -SetupOnly
	set "SETUP_DONE=1"
	if exist "%~dp0tools\node\node.exe" set "NODE_EXE=%~dp0tools\node\node.exe"
)
if not defined NODE_EXE (
	echo.
	echo [ERROR] Node.js tidak ditemukan dan gagal diunduh otomatis.
	echo         Pasang Node.js 18 atau lebih baru dari https://nodejs.org lalu jalankan file ini lagi.
	echo.
	pause
	exit /b 1
)

rem --- FFmpeg portable (kalau ada) diprioritaskan lewat PATH ---
if exist "%~dp0tools\ffmpeg\bin\ffmpeg.exe" set "PATH=%~dp0tools\ffmpeg\bin;%PATH%"
if exist "%~dp0tools\ffmpeg\ffmpeg.exe" set "PATH=%~dp0tools\ffmpeg;%PATH%"
for %%I in ("%NODE_EXE%") do set "PATH=%%~dpI;%PATH%"

where ffmpeg >nul 2>&1
if errorlevel 1 if not defined SETUP_DONE (
	echo [INFO] FFmpeg belum ada. Mencoba mengunduh FFmpeg portable...
	powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-and-run.ps1" -SetupOnly
)
if exist "%~dp0tools\ffmpeg\bin\ffmpeg.exe" set "PATH=%~dp0tools\ffmpeg\bin;%PATH%"
if exist "%~dp0tools\ffmpeg\ffmpeg.exe" set "PATH=%~dp0tools\ffmpeg;%PATH%"

rem --- Tutup server lama HANYA kalau node.exe yang memakai port ini (proses node lain aman) ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction Stop | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Write-Host ('Menutup server lama (PID ' + $p.Id + ')...'); Stop-Process -Id $p.Id -Force } } } catch {}" 2>nul

echo.
echo ==========================================
echo   UGC Flow Studio berjalan
echo   Buka di browser: http://localhost:%PORT%
echo   Tutup jendela ini atau tekan Ctrl+C untuk berhenti
echo ==========================================
echo.

set "OPEN_BROWSER=1"
"%NODE_EXE%" "%~dp0server\index.js"

echo.
echo Server berhenti.
pause
endlocal
