# T9 Editor LIT launcher (PowerShell)
#   .\Launch-T9EditorLIT.ps1            -> release exe if built, else build it once
#   .\Launch-T9EditorLIT.ps1 -Dev      -> cargo dev build with hot reload
#   .\Launch-T9EditorLIT.ps1 -NoDaemon -> skip the t9cloud AI daemon
param([switch]$Dev, [switch]$NoDaemon)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $root 'Clipchamp_Bunny'
Set-Location $app

Write-Host ''
Write-Host '========================================================' -ForegroundColor DarkYellow
Write-Host '        T9 Editor LIT  -  Zero-RAM Transcript Cutter' -ForegroundColor DarkYellow
Write-Host '========================================================' -ForegroundColor DarkYellow
Write-Host ''

# --- FFmpeg ----------------------------------------------------------------
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host '[x] FFmpeg not found on PATH.' -ForegroundColor Red
    Write-Host '    winget install Gyan.FFmpeg' -ForegroundColor Yellow
    exit 1
}
Write-Host '[ok] FFmpeg found.' -ForegroundColor Green

# --- t9cloud AI daemon (Groq / Gemini / Telegram) ---------------------------
if (-not $NoDaemon) {
    Write-Host '[..] t9cloud AI daemon (port 7878)...' -ForegroundColor Cyan
    $up = Get-NetTCPConnection -LocalPort 7878 -State Listen -ErrorAction SilentlyContinue
    if ($up) {
        Write-Host '     [ok] already running.' -ForegroundColor Green
    } else {
        $daemon = Join-Path $root 'go\bin\t9cloud.exe'
        if (Test-Path $daemon) {
            # absolute paths: the daemon resolves -env relative to its own cwd
            Start-Process -FilePath $daemon `
                -ArgumentList '-env', (Join-Path $root '.env') `
                -WorkingDirectory $root -WindowStyle Hidden
            Start-Sleep -Seconds 3
            $up = Get-NetTCPConnection -LocalPort 7878 -State Listen -ErrorAction SilentlyContinue
            if ($up) { Write-Host '     [ok] up.' -ForegroundColor Green }
            else { Write-Host '     [!] did not bind - cloud features stay offline.' -ForegroundColor DarkYellow }
        } else {
            Write-Host '     [!] go\bin\t9cloud.exe missing - cloud stays offline.' -ForegroundColor DarkYellow
        }
    }
}

# --- launch ----------------------------------------------------------------
Get-Process t9-editor-lit, nanami-cut -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue

$release = Join-Path $app 'src-tauri\target\release\t9-editor-lit.exe'
$releaseAlt = Join-Path $app 'src-tauri\target\release\nanami-cut.exe'

if ($Dev) {
    Write-Host '[..] Starting T9 Editor LIT (dev, hot reload)...' -ForegroundColor Cyan
    npm run app
} elseif (Test-Path $release) {
    Write-Host '[..] Starting T9 Editor LIT (release)...' -ForegroundColor Cyan
    Start-Process $release
} elseif (Test-Path $releaseAlt) {
    Write-Host '[..] Starting T9 Editor LIT (release)...' -ForegroundColor Cyan
    Start-Process $releaseAlt
} else {
    Write-Host '[!] No release build yet.' -ForegroundColor Yellow
    Write-Host '    The first build compiles ~380 Rust crates and takes 10-15 MINUTES.' -ForegroundColor Yellow
    Write-Host '    Building now - please wait.' -ForegroundColor Yellow
    npm run app:build
    if (Test-Path $release) { Start-Process $release } else { npm run app }
}
