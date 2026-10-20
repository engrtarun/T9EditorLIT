# T9 Editor LIT launcher (PowerShell)
#   .\Launch-T9EditorLIT.ps1            -> the installed (taskbar) app
#   .\Launch-T9EditorLIT.ps1 -Dev      -> cargo dev build with hot reload
#   .\Launch-T9EditorLIT.ps1 -NoDaemon -> skip the t9cloud AI daemon
#
# The installed copy wins on purpose. Starting the repository executable
# bypasses build.json, so the app would never see a staged update. Source
# builds belong to `-Dev`; shipping belongs to tools\deploy.ps1.
param([switch]$Dev, [switch]$NoDaemon)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $root 'Clipchamp_Bunny'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\T9EditorLIT'
$installedExe = Join-Path $installDir 't9-editor-lit.exe'
$installedDaemon = Join-Path $installDir 't9cloud.exe'
$installedEnv = Join-Path $installDir '.env'
$daemonPort = 7878

function Test-LoopbackPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $task.Wait(500)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Get-ProcessPath([int]$ProcessId) {
    try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        if ($cim -and $cim.ExecutablePath) { return $cim.ExecutablePath }
    } catch {
        # the process may have exited
    }
    return $null
}

Write-Host ''
Write-Host '========================================================' -ForegroundColor DarkYellow
Write-Host '        T9 Editor LIT  -  Zero-RAM Transcript Cutter' -ForegroundColor DarkYellow
Write-Host '========================================================' -ForegroundColor DarkYellow
Write-Host ''

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host '[x] FFmpeg not found on PATH.' -ForegroundColor Red
    Write-Host '    winget install Gyan.FFmpeg' -ForegroundColor Yellow
    exit 1
}
Write-Host '[ok] FFmpeg found.' -ForegroundColor Green

if ($Dev) {
    Set-Location $app
    Write-Host '[..] Starting T9 Editor LIT (dev, hot reload)...' -ForegroundColor Cyan
    npm run app
    exit $LASTEXITCODE
}

if (-not (Test-Path $installedExe)) {
    Write-Host '[x] No installed app found.' -ForegroundColor Red
    Write-Host '    Run Deploy-T9EditorLIT.bat (or Clipchamp_Bunny\tools\deploy.bat).' -ForegroundColor Yellow
    Write-Host '    The deploy builds, installs, verifies and pins the taskbar app.' -ForegroundColor Yellow
    Write-Host '    For source hacking use: .\Launch-T9EditorLIT.ps1 -Dev' -ForegroundColor DarkGray
    exit 1
}

if (-not $NoDaemon) {
    if (Test-LoopbackPort $daemonPort) {
        Write-Host "[ok] t9cloud daemon already listening on $daemonPort." -ForegroundColor Green
    } elseif (Test-Path $installedDaemon) {
        Write-Host "[..] starting the installed t9cloud daemon (port $daemonPort)..." -ForegroundColor Cyan
        try {
            if (Test-Path $installedEnv) {
                Start-Process -FilePath $installedDaemon -ArgumentList @('-env', $installedEnv) `
                    -WorkingDirectory $installDir -WindowStyle Hidden | Out-Null
            } else {
                Start-Process -FilePath $installedDaemon -WorkingDirectory $installDir `
                    -WindowStyle Hidden | Out-Null
            }
            Start-Sleep -Seconds 2
            if (Test-LoopbackPort $daemonPort) {
                Write-Host '     [ok] daemon up.' -ForegroundColor Green
            } else {
                Write-Host '     [!] daemon did not bind - cloud features stay offline.' -ForegroundColor DarkYellow
            }
        } catch {
            Write-Host "     [!] could not start the daemon: $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
    } else {
        Write-Host '     [!] installed t9cloud.exe missing - cloud features stay offline.' -ForegroundColor DarkYellow
    }
}

$running = @()
foreach ($proc in @(Get-Process -Name 't9-editor-lit' -ErrorAction SilentlyContinue)) {
    $path = $null
    try { $path = $proc.Path } catch { $path = Get-ProcessPath $proc.Id }
    if (-not $path) { $path = Get-ProcessPath $proc.Id }
    if ($path -and $path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase)) {
        $running += $proc
    }
}
if ($running.Count -gt 0) {
    Write-Host "[ok] the installed app is already running (pid $($running[0].Id))." -ForegroundColor Green
    Write-Host '     Use the taskbar / Start menu shortcut, or click Update in the app.' -ForegroundColor DarkGray
    exit 0
}

Write-Host '[..] Starting the installed app...' -ForegroundColor Cyan
Start-Process -FilePath $installedExe -WorkingDirectory $installDir
Write-Host '     [ok] started. The taskbar icon opens this same build.' -ForegroundColor Green
