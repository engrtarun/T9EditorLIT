<#
.SYNOPSIS
    Build the release executable, under a lock that keeps two builds apart.

.DESCRIPTION
    Two agents work on this repository, and both may want to build at the
    same time. **That is destructive here.** `tauri build` writes the
    frontend into `dist/` and then compiles the crate; if a second build
    rewrites `dist/` (or the crate's sources) in between, the two runs
    interleave and the executable that comes out is a *mixture* of both —
    a binary whose frontend and whose Rust side do not belong together.
    It shows up as a command that exists in the source but is missing from
    the executable, and it is very hard to see.

    So the build takes a lock first:

        src-tauri\target\.build-lock

    It is held for the whole run. A second build waits for it instead of
    racing it, and says so out loud.

.PARAMETER SkipLock
    Build without taking the lock. Only for a machine that is known to be
    the only builder.

.EXAMPLE
    pwsh -File tools\build.ps1
    pwsh -File tools\build.ps1 -SkipLock
#>
[CmdletBinding()]
param(
    [switch]$SkipLock
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AppDir = $PSScriptRoot | Split-Path -Parent
$Target = Join-Path $AppDir 'src-tauri\target'
$LockFile = Join-Path $Target '.build-lock'

New-Item -ItemType Directory -Force -Path $Target | Out-Null

$lock = $null
if (-not $SkipLock) {
    Write-Host '==> Waiting for the build lock' -ForegroundColor Cyan
    $waited = 0
    while ($true) {
        try {
            # FileShare.None: the lock is held by the file handle itself, so
            # it is released even if the build is killed.
            $lock = [System.IO.File]::Open(
                $LockFile,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
            break
        } catch {
            if ($waited -gt 3600) {
                Write-Host '    [!] gave up waiting for the build lock' -ForegroundColor Yellow
                exit 1
            }
            if ($waited % 30 -eq 0) {
                Write-Host "    ...still waiting ($waited s)" -ForegroundColor DarkGray
            }
            Start-Sleep -Seconds 2
            $waited += 2
        }
    }
    if ($waited -gt 0) {
        Write-Host "    [ok] got the lock after $waited s" -ForegroundColor Green
    } else {
        Write-Host '    [ok] got the lock' -ForegroundColor Green
    }
}

try {
    Write-Host '==> Building the release executable' -ForegroundColor Cyan
    Push-Location $AppDir
    try {
        & npx tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    Write-Host '    [ok] build finished' -ForegroundColor Green
} finally {
    if ($lock) {
        $lock.Close()
        $lock = $null
    }
}
