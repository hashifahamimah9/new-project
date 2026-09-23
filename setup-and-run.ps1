# UGC Flow Studio - Portable Setup & Runner
$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "   UGC Flow Studio - Setup & Launch Runner     " -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan

$ToolsDir = Join-Path $ScriptDir "tools"
$NodeDir = Join-Path $ToolsDir "node"
$FfmpegDir = Join-Path $ToolsDir "ffmpeg"

# 1. Periksa Node.js
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    $LocalNode = Join-Path $NodeDir "node.exe"
    if (Test-Path $LocalNode) {
        $env:PATH = "$NodeDir;$env:PATH"
        $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
    }
}

if (-not $NodeCmd) {
    Write-Host "[1/3] Mengunduh Node.js v20 LTS Portable..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
    $NodeZip = Join-Path $ToolsDir "node.zip"
    $NodeUrl = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip"
    
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip -UseBasicParsing
    
    Write-Host "      Mengekstrak Node.js..." -ForegroundColor Yellow
    $TempExtract = Join-Path $ToolsDir "node_temp"
    Expand-Archive -Path $NodeZip -DestinationPath $TempExtract -Force
    $ExtractedFolder = Get-ChildItem -Path $TempExtract -Directory | Select-Object -First 1
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    Move-Item -Path $ExtractedFolder.FullName -Destination $NodeDir
    Remove-Item -Recurse -Force $TempExtract -ErrorAction SilentlyContinue
    Remove-Item -Force $NodeZip -ErrorAction SilentlyContinue
    
    $env:PATH = "$NodeDir;$env:PATH"
    Write-Host "      [OK] Node.js siap di $NodeDir" -ForegroundColor Green
} else {
    Write-Host "[1/3] Node.js terdeteksi: $(node -v)" -ForegroundColor Green
}

# 2. Periksa FFmpeg
$FfmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $FfmpegCmd) {
    $LocalFfmpeg = Join-Path $FfmpegDir "ffmpeg.exe"
    if (Test-Path $LocalFfmpeg) {
        $env:PATH = "$FfmpegDir;$env:PATH"
        $FfmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    }
}

if (-not $FfmpegCmd) {
    Write-Host "[2/3] Mengunduh FFmpeg Portable..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
    $FfmpegZip = Join-Path $ToolsDir "ffmpeg.zip"
    $FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
    
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $FfmpegUrl -OutFile $FfmpegZip -UseBasicParsing
        
        Write-Host "      Mengekstrak FFmpeg..." -ForegroundColor Yellow
        $TempExtract = Join-Path $ToolsDir "ffmpeg_temp"
        Expand-Archive -Path $FfmpegZip -DestinationPath $TempExtract -Force
        $BinFolder = Get-ChildItem -Path $TempExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
        if ($BinFolder) {
            $SrcDir = $BinFolder.DirectoryName
            if (Test-Path $FfmpegDir) { Remove-Item -Recurse -Force $FfmpegDir }
            Move-Item -Path $SrcDir -Destination $FfmpegDir
        }
        Remove-Item -Recurse -Force $TempExtract -ErrorAction SilentlyContinue
        Remove-Item -Force $FfmpegZip -ErrorAction SilentlyContinue
        
        $env:PATH = "$FfmpegDir;$env:PATH"
        Write-Host "      [OK] FFmpeg siap di $FfmpegDir" -ForegroundColor Green
    } catch {
        Write-Host "      [INFO] FFmpeg dapat diinstal lewat winget install Gyan.FFmpeg jika download manual dibutuhkan." -ForegroundColor DarkYellow
    }
} else {
    Write-Host "[2/3] FFmpeg terdeteksi." -ForegroundColor Green
}

# 3. Jalankan Doctor & Server
Write-Host "[3/3] Memeriksa sistem (doctor)..." -ForegroundColor Cyan
node scripts/doctor.js

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "Membuka browser ke http://localhost:8787..." -ForegroundColor Green
Write-Host "Server UGC Flow Studio berjalan. Tekan Ctrl+C untuk berhenti." -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Cyan
Start-Process "http://localhost:8787"
node server/index.js
