param([switch]$SetupOnly)
# UGC Flow Studio - Portable Setup & Runner
# Pakai: klik kanan > Run with PowerShell, atau:
#   powershell -ExecutionPolicy Bypass -File setup-and-run.ps1            (setup + jalankan)
#   powershell -ExecutionPolicy Bypass -File setup-and-run.ps1 -SetupOnly (hanya unduh Node.js/FFmpeg)
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "   UGC Flow Studio - Setup & Launch Runner      " -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan

$ToolsDir = Join-Path $ScriptDir "tools"
$NodeDir = Join-Path $ToolsDir "node"
$FfmpegDir = Join-Path $ToolsDir "ffmpeg"
$NodeVersion = "v22.12.0"
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

if (-not (Test-Path (Join-Path $ScriptDir ".env")) -and (Test-Path (Join-Path $ScriptDir ".env.example"))) {
    Copy-Item (Join-Path $ScriptDir ".env.example") (Join-Path $ScriptDir ".env")
    Write-Host "      File .env dibuat dari .env.example" -ForegroundColor DarkGray
}

function Get-NodeMajor([string]$Exe) {
    try {
        $v = (& $Exe -v) 2>$null
        if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    } catch {}
    return 0
}

function Find-Node {
    $candidates = @()
    $candidates += (Join-Path $NodeDir "node.exe")
    if (Test-Path $NodeDir) {
        Get-ChildItem -Path $NodeDir -Directory -Filter "node-*" -ErrorAction SilentlyContinue | ForEach-Object {
            $candidates += (Join-Path $_.FullName "node.exe")
        }
    }
    $sys = Get-Command node -ErrorAction SilentlyContinue
    if ($sys) { $candidates += $sys.Source }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c) -and ((Get-NodeMajor $c) -ge 18)) { return $c }
    }
    return $null
}

function Find-Ffmpeg {
    $candidates = @((Join-Path $FfmpegDir "bin\ffmpeg.exe"), (Join-Path $FfmpegDir "ffmpeg.exe"))
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    $sys = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($sys) { return $sys.Source }
    return $null
}

# 1. Node.js
$NodeExe = Find-Node
if (-not $NodeExe) {
    Write-Host "[1/3] Mengunduh Node.js $NodeVersion portable..." -ForegroundColor Yellow
    $NodeZip = Join-Path $ToolsDir "node.zip"
    $NodeUrl = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
    try {
        Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip -UseBasicParsing
        Write-Host "      Mengekstrak Node.js..." -ForegroundColor Yellow
        $TempExtract = Join-Path $ToolsDir "node_temp"
        if (Test-Path $TempExtract) { Remove-Item -Recurse -Force $TempExtract }
        Expand-Archive -Path $NodeZip -DestinationPath $TempExtract -Force
        $ExtractedFolder = Get-ChildItem -Path $TempExtract -Directory | Select-Object -First 1
        if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
        Move-Item -Path $ExtractedFolder.FullName -Destination $NodeDir
        Remove-Item -Recurse -Force $TempExtract -ErrorAction SilentlyContinue
        Remove-Item -Force $NodeZip -ErrorAction SilentlyContinue
        $NodeExe = Find-Node
        if ($NodeExe) { Write-Host "      [OK] Node.js siap di $NodeDir" -ForegroundColor Green }
    } catch {
        Write-Host "      [GAGAL] Tidak bisa mengunduh Node.js: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "      Pasang manual dari https://nodejs.org (versi 18 ke atas)." -ForegroundColor Red
    }
} else {
    Write-Host "[1/3] Node.js terdeteksi: $(& $NodeExe -v) ($NodeExe)" -ForegroundColor Green
}

# 2. FFmpeg
$FfmpegExe = Find-Ffmpeg
if (-not $FfmpegExe) {
    Write-Host "[2/3] Mengunduh FFmpeg portable (sekitar 100 MB)..." -ForegroundColor Yellow
    $FfmpegZip = Join-Path $ToolsDir "ffmpeg.zip"
    $FfmpegUrls = @(
        "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    )
    foreach ($FfmpegUrl in $FfmpegUrls) {
        try {
            Invoke-WebRequest -Uri $FfmpegUrl -OutFile $FfmpegZip -UseBasicParsing
            Write-Host "      Mengekstrak FFmpeg..." -ForegroundColor Yellow
            $TempExtract = Join-Path $ToolsDir "ffmpeg_temp"
            if (Test-Path $TempExtract) { Remove-Item -Recurse -Force $TempExtract }
            Expand-Archive -Path $FfmpegZip -DestinationPath $TempExtract -Force
            $BinFile = Get-ChildItem -Path $TempExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
            if ($BinFile) {
                if (Test-Path $FfmpegDir) { Remove-Item -Recurse -Force $FfmpegDir }
                New-Item -ItemType Directory -Force -Path $FfmpegDir | Out-Null
                Move-Item -Path $BinFile.DirectoryName -Destination (Join-Path $FfmpegDir "bin")
            }
            Remove-Item -Recurse -Force $TempExtract -ErrorAction SilentlyContinue
            Remove-Item -Force $FfmpegZip -ErrorAction SilentlyContinue
            $FfmpegExe = Find-Ffmpeg
            if ($FfmpegExe) {
                Write-Host "      [OK] FFmpeg siap di $FfmpegDir\bin" -ForegroundColor Green
                break
            }
        } catch {
            Write-Host "      [INFO] Gagal dari $FfmpegUrl : $($_.Exception.Message)" -ForegroundColor DarkYellow
            Remove-Item -Force $FfmpegZip -ErrorAction SilentlyContinue
        }
    }
    if (-not $FfmpegExe) {
        Write-Host "      [INFO] FFmpeg belum terpasang. Alternatif: winget install Gyan.FFmpeg" -ForegroundColor DarkYellow
    }
} else {
    Write-Host "[2/3] FFmpeg terdeteksi: $FfmpegExe" -ForegroundColor Green
}

if ($FfmpegExe) { $env:PATH = (Split-Path -Parent $FfmpegExe) + ";" + $env:PATH }
if ($NodeExe) { $env:PATH = (Split-Path -Parent $NodeExe) + ";" + $env:PATH }

if ($SetupOnly) {
    if ($NodeExe) { exit 0 } else { exit 1 }
}

if (-not $NodeExe) {
    Write-Host "Node.js tidak tersedia, server tidak bisa dijalankan." -ForegroundColor Red
    Read-Host "Tekan Enter untuk keluar"
    exit 1
}

# 3. Doctor & Server
Write-Host "[3/3] Memeriksa sistem (doctor)..." -ForegroundColor Cyan
& $NodeExe scripts/doctor.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "Doctor menemukan masalah [FAIL] di atas. Server tetap dijalankan, tapi render bisa gagal sampai masalahnya dibereskan." -ForegroundColor Yellow
}

Write-Host "================================================" -ForegroundColor Cyan
Write-Host "Server UGC Flow Studio berjalan, browser akan terbuka otomatis." -ForegroundColor Green
Write-Host "Tekan Ctrl+C untuk berhenti." -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Cyan
$env:OPEN_BROWSER = "1"
& $NodeExe server/index.js
