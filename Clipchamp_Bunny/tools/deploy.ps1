<#
.SYNOPSIS
    Install T9 Editor LIT to a stable folder and (re)pin it to the taskbar.

.DESCRIPTION
    The app is launched from the taskbar, so it must live at a path that does
    not move when the repository is rebuilt or `cargo clean` runs. This script
    copies the freshly built executable into

        %LOCALAPPDATA%\Programs\T9EditorLIT\

    together with the `t9cloud` cloud daemon and the `.env` file, writes a
    shortcut and pins that shortcut to the taskbar.

    After this script has run once, updating the app is just: build, run this
    script again. The pinned icon never changes.

.PARAMETER SkipBuild
    Do not rebuild - just install the executable that is already in target/.

.PARAMETER SkipPin
    Install and create the shortcut, but do not touch the taskbar.

.PARAMETER Launch
    Start the app after installing.

.EXAMPLE
    pwsh -File tools/deploy.ps1
    pwsh -File tools/deploy.ps1 -SkipBuild -Launch
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipPin,
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AppDir   = $PSScriptRoot | Split-Path -Parent          # Clipchamp_Bunny
$RepoRoot = $AppDir | Split-Path -Parent                # repository root
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\T9EditorLIT'
$ExeName  = 't9-editor-lit.exe'
$Shortcut = Join-Path $InstallDir 'T9 Editor LIT.lnk'

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "    [ok] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "    [!]  $Message" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 1. build ---
if (-not $SkipBuild) {
    Write-Step 'Building the release executable (this takes a few minutes)...'
    Push-Location $AppDir
    try {
        & npx tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
} else {
    Write-Step 'Skipping the build (--SkipBuild)'
}

$BuiltExe = Join-Path $AppDir "src-tauri\target\release\$ExeName"
if (-not (Test-Path $BuiltExe)) {
    throw "No executable at $BuiltExe - run without -SkipBuild first."
}

# -------------------------------------------------------------- 2. install ---
Write-Step "Installing into $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Leftovers from an earlier update attempt: a half-swapped binary would be
# worse than no binary at all.
foreach ($stale in @('t9-editor-lit.old.exe', 't9cloud.old.exe')) {
    $stalePath = Join-Path $InstallDir $stale
    if (Test-Path $stalePath) {
        Remove-Item $stalePath -Force -ErrorAction SilentlyContinue
        Write-Ok "removed the leftover $stale"
    }
}

$running = Get-Process -Name 't9-editor-lit' -ErrorAction SilentlyContinue

if ($running) {
    # The app is open, so its executable is locked. The new build is **staged**
    # next to it instead, and the running app shows a small "Update" button:
    # one click swaps the binary and starts the new build.
    Write-Ok 'The app is running - staging the new build for a restart'
    Copy-Item $BuiltExe (Join-Path $InstallDir 't9-editor-lit.new.exe') -Force
    Write-Ok 't9-editor-lit.new.exe (staged)'
} else {
    Copy-Item $BuiltExe (Join-Path $InstallDir $ExeName) -Force
    Write-Ok $ExeName
}

# The marker the app reads to notice a newer build.
$buildInfo = @{
    version  = '0.1.0'
    builtAt  = (Get-Date).ToUniversalTime().ToString('o')
    stagedAt = if ($running) { (Get-Date).ToUniversalTime().ToString('o') } else { $null }
} | ConvertTo-Json
Set-Content -Path (Join-Path $InstallDir 'build.json') -Value $buildInfo -Encoding UTF8
Write-Ok 'build.json (update marker)'

$Daemon = Join-Path $RepoRoot 'go\bin\t9cloud.exe'

# The Go daemon is the **other agent's** scope. When its sources are newer
# than the binary, rebuild it here - otherwise a daemon change would never
# reach the desktop app.
$GoRoot = Join-Path $RepoRoot 'go'
if (Test-Path $GoRoot) {
    $newestSource = Get-ChildItem $GoRoot -Recurse -Include *.go -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $needsBuild = $true
    if ($newestSource -and (Test-Path $Daemon)) {
        $needsBuild = $newestSource.LastWriteTime -gt (Get-Item $Daemon).LastWriteTime
    }
    if ($needsBuild) {
        Write-Step 'Rebuilding the t9cloud daemon (Go side)'
        Push-Location $GoRoot
        try {
            & go build -o bin/t9cloud.exe ./cmd/t9cloud
            if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
            Write-Ok 't9cloud.exe rebuilt'
        } finally {
            Pop-Location
        }
    } else {
        Write-Step 'The daemon is up to date'
    }
}

if (Test-Path $Daemon) {
    # A running daemon locks its own executable, so it is staged the same way
    # as the app and swapped in by the update helper.
    $daemonRunning = Get-Process -Name 't9cloud' -ErrorAction SilentlyContinue
    if ($daemonRunning) {
        Copy-Item $Daemon (Join-Path $InstallDir 't9cloud.new.exe') -Force
        Write-Ok 't9cloud.new.exe (staged - the running daemon is swapped in on restart)'
    } else {
        Copy-Item $Daemon (Join-Path $InstallDir 't9cloud.exe') -Force
        Write-Ok 't9cloud.exe (cloud daemon)'
    }
} else {
    Write-Warn 'go\bin\t9cloud.exe is missing - cloud features stay offline'
}

$EnvFile = Join-Path $RepoRoot '.env'
if (Test-Path $EnvFile) {
    Copy-Item $EnvFile (Join-Path $InstallDir '.env') -Force
    Write-Ok '.env (API keys for the daemon)'
} else {
    Write-Warn '.env is missing - the daemon will start without API keys'
}

# ------------------------------------------------------------- 3. shortcut ---
Write-Step 'Writing the shortcut'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($Shortcut)
$lnk.TargetPath       = Join-Path $InstallDir $ExeName
$lnk.WorkingDirectory = $InstallDir
$lnk.IconLocation     = "$InstallDir\$ExeName,0"
$lnk.Description      = 'T9 Editor LIT - transcript-first video cutter'
$lnk.Save()
Write-Ok $Shortcut

# ----------------------------------------------------------------- 4. pin ---
if (-not $SkipPin) {
    Write-Step 'Pinning to the taskbar'
    # The pin script owns the Start menu shortcut and the AppUserModelID; it
    # needs the install folder, not the .lnk, because it writes its own
    # shortcut where Windows looks for it.
    & (Join-Path $PSScriptRoot 'pin-taskbar.ps1') -InstallDir $InstallDir
    if ($LASTEXITCODE -ne 0) {
        Write-Warn 'the shell refused the pin - pin it by hand from the Start menu search'
    }
}

# -------------------------------------------------------------- 5. launch ---
if ($Launch) {
    Write-Step 'Starting the app'
    Start-Process (Join-Path $InstallDir $ExeName)
    Write-Ok 'launched'
}

Write-Step 'Done'
Write-Host "    The app now lives in $InstallDir" -ForegroundColor Green
if ($running) {
    Write-Host ''
    Write-Host '    The app is still running the old build.' -ForegroundColor Yellow
    Write-Host '    Its top bar now shows a small "Update" button - click it and the' -ForegroundColor Yellow
    Write-Host '    new build (app + cloud daemon) is swapped in and started.' -ForegroundColor Yellow
} else {
    Write-Host '    The pinned taskbar icon starts the new build directly.' -ForegroundColor Green
}
