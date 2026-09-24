@echo off
setlocal
title UGC Flow Studio - Update
cd /d "%~dp0"

echo.
echo ==========================================
echo   UGC Flow Studio - Update dari GitHub
echo ==========================================
echo.

where git >nul 2>&1
if errorlevel 1 goto nogit
if not exist ".git" goto noclone

rem --- Baca PORT dari .env lalu tutup server yang sedang jalan supaya database tidak bentrok ---
set "PORT=8787"
if exist ".env" for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="PORT" for /f "tokens=1" %%P in ("%%B") do set "PORT=%%P"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction Stop | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Write-Host ('Menutup server yang sedang jalan (PID ' + $p.Id + ')...'); Stop-Process -Id $p.Id -Force } } } catch {}" 2>nul

rem --- Amankan database lokal (data\db.json) sebelum update ---
if exist "data\db.json" copy /y "data\db.json" "data\db-update-backup.json" >nul
git ls-files --error-unmatch data/db.json >nul 2>&1 && git checkout -- data/db.json

rem Semua langkah setelah git pull ada di dalam satu blok ( ... ) supaya tetap aman
rem walaupun file ini sendiri ikut diperbarui oleh git pull.
(
	echo Mengambil update terbaru dari GitHub...
	git pull --ff-only
	if errorlevel 1 (set "PULL_OK=") else (set "PULL_OK=1")
	if exist "data\db-update-backup.json" move /y "data\db-update-backup.json" "data\db.json" >nul
	if not defined PULL_OK (
		echo.
		echo [ERROR] Update gagal. Database kamu tetap aman di data\db.json.
		echo         Cek koneksi internet, lalu jalankan "git status" untuk melihat file yang bentrok.
		echo.
		pause
		exit /b 1
	)
	echo.
	echo [OK] Update selesai.
	echo      - Jalankan lagi KLIK-DISINI-UNTUK-MULAI.bat atau Jalankan.vbs
	echo      - Kalau memakai extension Chrome: buka chrome://extensions lalu klik Reload
	echo.
	pause
	exit /b 0
)

:nogit
echo [ERROR] Git belum terpasang di komputer ini.
echo         Pasang Git dari https://git-scm.com lalu jalankan file ini lagi, atau
echo         download ZIP terbaru dari GitHub, ekstrak, lalu timpa isi folder ini.
echo         Folder data, storage dan file .env tidak ikut tertimpa.
echo.
pause
exit /b 1

:noclone
echo [INFO] Folder ini bukan hasil "git clone", jadi tidak bisa update otomatis.
echo        Download ZIP terbaru dari GitHub, ekstrak, lalu timpa isi folder ini.
echo        Folder data, storage dan file .env tidak ikut tertimpa.
echo.
pause
exit /b 1
