<#
.SYNOPSIS
    Build the release executable, under a lock that keeps two builds apart.

.DESCRIPTION
    Two agents work on this repository, and both may want to build at the same
    time. **That is destructive here.** `tauri build` writes the frontend into
    `dist/` and then compiles the crate; if a second build rewrites `dist/` (or
    the crate's sources) in between, the two runs interleave and the executable
    that comes out is a *mixture* of both - a binary whose frontend and whose
    Rust side do not belong together. It shows up as a command that exists in
    the source but is missing from the executable, and it is very hard to see.

    So the build takes a lock first:

        <target>\.build-lock

    It is held for the whole run. A second build waits for it instead of
    racing it, and says so out loud.

    Every successful build writes a **build manifest**:

        <target>\release\build-manifest.json
        %LOCALAPPDATA%\T9EditorLIT\deploy\builds\<buildId>.json
        %LOCALAPPDATA%\T9EditorLIT\deploy\builds\latest.json

    The manifest records the exact executable path and SHA-256. `deploy.ps1`
    installs *that* file - never "whatever happens to be in the default
    target folder". This closes the isolated-target hole: an agent may build
    with T9_TARGET_DIR, and the deploy still finds the real binary.

    The build id is also compiled into the executable (T9_BUILD_ID ->
    src-tauri/build.rs -> src-tauri/src/lib.rs) and into the Go daemon's
    `api.Version`, so the ledger can prove which build is actually running.

.PARAMETER SkipLock
    Build without taking the lock. Only for a machine that is known to be
    the only builder.

.PARAMETER BuildId
    Use a specific build id. `deploy.ps1` passes one so the marker, the Rust
    binary and the daemon all carry the same id.

.PARAMETER WorkId
    The ledger work order this build belongs to (optional for a manual build).

.EXAMPLE
    pwsh -File tools\build.ps1
    pwsh -File tools\build.ps1 -SkipLock
#>
[CmdletBinding()]
param(
    [switch]$SkipLock,
    [string]$BuildId = '',
    [string]$WorkId = '',
    [string]$Agent = '',
    [string]$Model = '',
    [string]$ManifestDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AppDir = $PSScriptRoot | Split-Path -Parent
$RepoRoot = $AppDir | Split-Path -Parent
$Target = Join-Path $AppDir 'src-tauri\target'
$LockFile = Join-Path $Target '.build-lock'

function Get-GitText([string[]]$GitArgs) {
    try {
        $value = & git -C $RepoRoot @GitArgs 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return (($value | Out-String).Trim())
    } catch {
        return $null
    }
}

if (-not $BuildId) { $BuildId = $env:T9_BUILD_ID }
if (-not $BuildId) {
    $short = Get-GitText @('rev-parse', '--short', 'HEAD')
    if (-not $short) { $short = 'nogit' }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
    $rand = -join ((1..4) | ForEach-Object { '{0:x}' -f (Get-Random -Minimum 0 -Maximum 16) })
    $BuildId = "app-$short-$stamp-$rand"
}
# A build id travels through JSON, a file name, a CMD script and a Go linker
# flag; keep it to a boring alphabet so none of those layers can reinterpret it.
$BuildId = ($BuildId -replace '[^A-Za-z0-9._-]', '-')
$env:T9_BUILD_ID = $BuildId

# An agent that builds in its own target folder never collides with another
# one's build. Set T9_TARGET_DIR to use one; the default is the shared
# folder, where the build lock keeps the two apart.
if ($env:T9_TARGET_DIR) {
    $Target = $env:T9_TARGET_DIR
    $LockFile = Join-Path $Target '.build-lock'
    # Cargo has to be told as well - `T9_TARGET_DIR` is our own name for it,
    # and without this the build would land in the shared target folder and
    # collide with another agent's build all the same.
    $env:CARGO_TARGET_DIR = $Target
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
                throw 'gave up waiting for the build lock after 60 minutes'
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

    Write-Host "==> Building the release executable ($BuildId)" -ForegroundColor Cyan
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

    $Exe = Join-Path $Target 'release\t9-editor-lit.exe'
    if (-not (Test-Path $Exe)) {
        throw "the build finished but $Exe is missing"
    }
    $exeItem = Get-Item $Exe
    $hash = (Get-FileHash $Exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $builtAt = $exeItem.LastWriteTimeUtc.ToString('o')
    $gitCommit = Get-GitText @('rev-parse', 'HEAD')
    $gitShort = Get-GitText @('rev-parse', '--short', 'HEAD')
    $gitBranch = Get-GitText @('rev-parse', '--abbrev-ref', 'HEAD')
    $gitStatus = Get-GitText @('status', '--porcelain')
    $gitDirty = [bool]($gitStatus -and $gitStatus.Length -gt 0)

    $manifest = [ordered]@{
        schema      = 1
        buildId     = $BuildId
        builtAt     = $builtAt
        exe         = $Exe
        sha256      = $hash
        size        = $exeItem.Length
        targetDir   = $Target
        appDir      = $AppDir
        repoRoot    = $RepoRoot
        workId      = if ($WorkId) { $WorkId } else { $null }
        agent       = if ($Agent) { $Agent } else { $null }
        model       = if ($Model) { $Model } else { $null }
        gitCommit   = $gitCommit
        gitShort    = $gitShort
        gitBranch   = $gitBranch
        gitDirty    = $gitDirty
        host        = $env:COMPUTERNAME
        builtByPid  = $PID
        createdAt   = (Get-Date).ToUniversalTime().ToString('o')
    }

    # `latest.json` lives outside the worktree so every agent - even one that
    # built in its own T9_TARGET_DIR - points at the same newest manifest.
    if (-not $ManifestDir) {
        if ($env:LOCALAPPDATA) {
            $ManifestDir = Join-Path $env:LOCALAPPDATA 'T9EditorLIT\deploy\builds'
        } else {
            $ManifestDir = Join-Path $RepoRoot '.t9\builds'
        }
    }
    New-Item -ItemType Directory -Force -Path $ManifestDir | Out-Null
    $json = $manifest | ConvertTo-Json -Depth 6
    $utf8 = New-Object System.Text.UTF8Encoding($false)

    $releaseManifest = Join-Path $Target 'release\build-manifest.json'
    [System.IO.File]::WriteAllText($releaseManifest, $json, $utf8)
    $buildManifest = Join-Path $ManifestDir "$BuildId.json"
    [System.IO.File]::WriteAllText($buildManifest, $json, $utf8)
    $latestManifest = Join-Path $ManifestDir 'latest.json'
    [System.IO.File]::WriteAllText($latestManifest, $json, $utf8)

    Write-Host '    [ok] build finished' -ForegroundColor Green
    Write-Host "    BUILD_ID=$BuildId" -ForegroundColor DarkGray
    Write-Host "    BUILD_SHA256=$hash" -ForegroundColor DarkGray
    Write-Host "    BUILD_MANIFEST=$buildManifest" -ForegroundColor DarkGray
    Write-Host "    BUILD_EXE=$Exe" -ForegroundColor DarkGray

    return [pscustomobject]$manifest
} finally {
    if ($lock) {
        $lock.Close()
        $lock = $null
    }
}
