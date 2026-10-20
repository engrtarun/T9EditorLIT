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

# An agent that builds in its own target folder never collides with another
# one's build. Set T9_TARGET_DIR to use one; the default is the shared
# folder, where the build lock keeps the two apart.
if ($env:T9_TARGET_DIR) {
    $Target = $env:T9_TARGET_DIR
    $LockFile = Join-Path $Target '.build-lock'
    Write-Host "    [ok] using an isolated target folder: $Target" -ForegroundColor DarkGray
}

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
    # The machine runs the app and several agents; a full Rust link can push
    # 8 GB into swap. When RAM is tight, cap cargo's parallelism so the build
    # finishes instead of dying (slower, but predictable).
    $freeGB = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 1)
    if ($freeGB -lt 2.5) {
        Write-Host "    [!] only $freeGB GB RAM free - cargo limited to 2 jobs" -ForegroundColor Yellow
        $env:CARGO_BUILD_JOBS = '2'
    }

    Write-Host '==> Building the release executable' -ForegroundColor Cyan
    # The Tauri build script caches the **list of embedded frontend assets**
    # in its own output folder, and it does not refresh that list when the
    # frontend changes. The executable then carries an older `dist/` - the app
    # calls commands the Rust side does not have, and the "command not found"
    # error is invisible in the UI.
    #
    # Delete the **whole** package build folder, not just `out/`. Cargo decides
    # whether to rerun a build script from its fingerprint, and a fresh
    # fingerprint plus a deleted `out/` means no rerun - the link then dies with
    # `LNK1181: cannot open input file '...\out\resource.lib'`. Removing the
    # folder (including `output`/`root-output`) makes cargo rerun the script.
    $buildDir = Join-Path $Target 'release\build'
    Get-ChildItem $buildDir -Directory -Filter 't9-editor-lit-*' -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host '    [ok] cleared the cached asset list' -ForegroundColor DarkGray

    Push-Location $AppDir
    try {
        # The frontend is built **here**, and its exit code is checked, before
        # the Rust build starts.
        #
        # This is the step that bit us: a stray brace in `ipc.ts` made the
        # frontend build fail, the old `dist/` stayed on disk, and the
        # executable was built with that old frontend - so the app called
        # commands the Rust side did not have, and the error was invisible.
        # Building it first and stopping on failure keeps a stale `dist/`
        # from ever being embedded.
        Write-Host '==> Building the frontend' -ForegroundColor Cyan
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "the frontend build failed (exit code $LASTEXITCODE) - the old dist/ would have been embedded"
        }
        Write-Host '    [ok] frontend built' -ForegroundColor Green

        # The link step is the fragile one on a small machine: it needs a
        # gigabyte of RAM, and it fails with `LNK1181` when another build is
        # using the same output file or the machine is out of memory. Retrying
        # after a short wait turns a hard failure into a slow one.
        $attempt = 0
        while ($true) {
            $attempt++
            & npx tauri build --no-bundle
            if ($LASTEXITCODE -eq 0) { break }
            if ($attempt -ge 3) {
                throw "tauri build failed with exit code $LASTEXITCODE (after $attempt attempts)"
            }
            Write-Host "    [!] build attempt $attempt failed - retrying in 45 s" -ForegroundColor Yellow
            Start-Sleep -Seconds 45
            # The build folder is cleared **before** the first attempt only.
            # Clearing it while a link is running is what produces
            # `LNK1181: cannot open input file '...\out\resource.lib'` - and
            # it can kill *another* agent's link, not just this one.
        }
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
