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

# The running app holds a lock on its own executable.
$running = Get-Process -Name 't9-editor-lit' -ErrorAction SilentlyContinue
if ($running) {
    Write-Ok 'Closing the running app'
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 800
}

Copy-Item $BuiltExe (Join-Path $InstallDir $ExeName) -Force
Write-Ok $ExeName

$Daemon = Join-Path $RepoRoot 'go\bin\t9cloud.exe'
if (Test-Path $Daemon) {
    Copy-Item $Daemon (Join-Path $InstallDir 't9cloud.exe') -Force
    Write-Ok 't9cloud.exe (cloud daemon)'
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
    & (Join-Path $PSScriptRoot 'pin-taskbar.ps1') -Shortcut $Shortcut
}

# -------------------------------------------------------------- 5. launch ---
if ($Launch) {
    Write-Step 'Starting the app'
    Start-Process (Join-Path $InstallDir $ExeName)
    Write-Ok 'launched'
}

Write-Step 'Done'
Write-Host "    The app now lives in $InstallDir" -ForegroundColor Green
