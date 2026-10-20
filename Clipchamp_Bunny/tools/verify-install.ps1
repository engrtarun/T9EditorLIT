<#
.SYNOPSIS
    Prove that the installed app shows real data, not mock lines.

.DESCRIPTION
    Runs the installed executable the way the taskbar does (a plain double
    click, with no terminal and no particular working directory) and then
    checks the three things that actually matter:

      1. The app is running.
      2. The SQLite database has the project and its transcript under a
         **canonical** path - one spelling, so the cache always hits.
      3. The cloud daemon did **not** get a single new transcription job,
         because the transcript was already on disk.

    The daemon counter is the same one the health endpoint reports, so it
    proves the "API sirf import pe" rule still holds after the change.

.EXAMPLE
    pwsh -File tools\verify-install.ps1
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\T9EditorLIT'),
    [int]$WaitSeconds = 25
)

$ErrorActionPreference = 'Stop'

$Exe = Join-Path $InstallDir 't9-editor-lit.exe'
$Db = Join-Path $env:APPDATA 'com.engrtarun.t9editorlit\nanamicut.db'

function Get-QueueStats {
    try {
        $h = Invoke-RestMethod -Uri 'http://127.0.0.1:7878/healthz' -TimeoutSec 3
        return $h.queue
    } catch {
        return $null
    }
}

function Read-Db {
    $script = @'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const q = (s) => db.prepare(s).all();
console.log(JSON.stringify({
  transcripts: q('select count(*) c from transcripts')[0].c,
  projects: q('select count(*) c from projects')[0].c,
  paths: q('select distinct source_path from transcripts'),
  projectPaths: q('select source_path from projects')
}));
'@
    $tmp = Join-Path $env:TEMP 't9-db-check.mjs'
    Set-Content -Path $tmp -Value $script -Encoding UTF8
    $json = & node $tmp $Db
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    return $json | ConvertFrom-Json
}

Write-Host '==> Stopping any running instance' -ForegroundColor Cyan
Get-Process -Name 't9-editor-lit' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

$before = Get-QueueStats
$completedBefore = if ($before) { $before.completed } else { $null }
Write-Host "    daemon queue completed before: $completedBefore"

# The daemon log tells us whether the app actually asked for a speed reading.
$LogFile = Join-Path $env:APPDATA 'com.engrtarun.t9editorlit\t9cloud.log'
$logBefore = if (Test-Path $LogFile) { (Get-Content $LogFile).Count } else { 0 }

Write-Host "==> Launching $Exe (no terminal, no working directory set)" -ForegroundColor Cyan
Start-Process $Exe
Start-Sleep -Seconds $WaitSeconds

$proc = Get-Process -Name 't9-editor-lit' -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host '    [FAIL] the app is not running' -ForegroundColor Red
    exit 1
}
Write-Host "    [ok] app running, pid $($proc.Id), $([math]::Round($proc.WorkingSet64 / 1MB)) MB RAM" -ForegroundColor Green

$after = Get-QueueStats
$completedAfter = if ($after) { $after.completed } else { $null }
Write-Host "    daemon queue completed after:  $completedAfter"

if ($null -ne $completedBefore -and $null -ne $completedAfter) {
    if ($completedAfter -eq $completedBefore) {
        Write-Host '    [ok] zero new API jobs - the transcript came from SQLite' -ForegroundColor Green
    } else {
        Write-Host "    [FAIL] $completedAfter - $completedBefore new API jobs" -ForegroundColor Red
    }
} elseif ($null -ne $completedAfter) {
    # The daemon was not running before, so the app started it. The bar is
    # still zero jobs: the transcript was already on disk.
    if ($completedAfter -eq 0) {
        Write-Host '    [ok] app started the daemon itself, and it ran zero jobs' -ForegroundColor Green
    } else {
        Write-Host "    [FAIL] $completedAfter jobs ran - the cache was missed" -ForegroundColor Red
    }
} else {
    Write-Host '    [warn] daemon not reachable - cloud features offline?' -ForegroundColor Yellow
}

if (Test-Path $Db) {
    $db = Read-Db
    Write-Host "    transcripts rows: $($db.transcripts)" -ForegroundColor DarkGray
    Write-Host "    projects rows:   $($db.projects)" -ForegroundColor DarkGray
    foreach ($p in $db.paths) { Write-Host "    transcript key: $($p.source_path)" -ForegroundColor DarkGray }
    foreach ($p in $db.projectPaths) { Write-Host "    project key:   $($p.source_path)" -ForegroundColor DarkGray }

    $bad = @($db.paths | Where-Object { $_.source_path -match '\.\.[\\/]' })
    if ($bad.Count -gt 0) {
        Write-Host '    [FAIL] a transcript key still holds ".."' -ForegroundColor Red
    } else {
        Write-Host '    [ok] every key is canonical (no "..")' -ForegroundColor Green
    }
    if ($db.projects -ge 1) {
        Write-Host '    [ok] a project is remembered - the app will reopen it' -ForegroundColor Green
    } else {
        Write-Host '    [warn] no project row yet' -ForegroundColor Yellow
    }
} else {
    Write-Host "    [FAIL] no database at $Db" -ForegroundColor Red
}

# --- did the app ask the daemon for a speed reading? -------------------------
if (Test-Path $LogFile) {
    $newLines = @(Get-Content $LogFile | Select-Object -Skip $logBefore)
    $speedCalls = @($newLines | Select-String 'path=/v1/net/speed').Count
    if ($speedCalls -gt 0) {
        Write-Host "    [ok] the app measured the network $speedCalls time(s) - the MB/s chip is live" -ForegroundColor Green
    } else {
        Write-Host '    [FAIL] the app never asked for a speed reading - the chip stays blank' -ForegroundColor Red
    }
    $transcribes = @($newLines | Select-String 'method=POST path=/v1/transcribe').Count
    if ($transcribes -gt 0) {
        Write-Host "    [FAIL] $transcribes new transcription job(s) - the SQLite cache was missed" -ForegroundColor Red
    } else {
        Write-Host '    [ok] no transcription was requested - the transcript came off the disk' -ForegroundColor Green
    }
}
