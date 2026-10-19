# Nanami Cut launcher (PowerShell)
# Usage:  .\Launch-NanamiCut.ps1            (dev build, hot reload)
#         .\Launch-NanamiCut.ps1 -Release  (optimised build)

param([switch]$Release)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $root 'Clipchamp_Bunny'
Set-Location $app

Write-Host ''
Write-Host '========================================================' -ForegroundColor DarkYellow
Write-Host '       Nanami Cut  -  Zero-RAM Transcript Cutter'   -ForegroundColor DarkYellow
Write-Host '========================================================' -ForegroundColor DarkYellow
Write-Host ''

# --- FFmpeg ----------------------------------------------------------------
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpeg) {
    Write-Host '[x] FFmpeg not found on PATH.' -ForegroundColor Red
    Write-Host '    winget install Gyan.FFmpeg' -ForegroundColor Yellow
    exit 1
}
Write-Host "[ok] FFmpeg: $($ffmpeg.Source)" -ForegroundColor Green

# --- t9cloud (Go daemon: Groq / Gemini / Telegram) -----------------------
$portUp = Get-NetTCPConnection -LocalPort 7878 -State Listen -ErrorAction SilentlyContinue
if (-not $portUp) {
    $daemon = Join-Path $root 'go\bin\t9cloud.exe'
    if (Test-Path $daemon) {
        Write-Host '[..] Starting t9cloud AI daemon...' -ForegroundColor Cyan
        Start-Process -FilePath $daemon -ArgumentList '-env', (Join-Path $root '.env') -WindowStyle Hidden
        Start-Sleep -Seconds 2
    } else {
        Write-Host '[i] t9cloud not built - cloud features stay offline.' -ForegroundColor DarkGray
    }
} else {
    Write-Host '[ok] t9cloud already listening on 7878.' -ForegroundColor Green
}

# --- launch ----------------------------------------------------------------
Get-Process nanami-cut -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if ($Release) {
    Write-Host '[..] Building release...' -ForegroundColor Cyan
    npm run app:build
    $exe = Join-Path $app 'src-tauri\target\release\nanami-cut.exe'
    if (Test-Path $exe) { Start-Process $exe }
} else {
    Write-Host '[..] Starting Nanami Cut (dev)...' -ForegroundColor Cyan
    npm run app
}
