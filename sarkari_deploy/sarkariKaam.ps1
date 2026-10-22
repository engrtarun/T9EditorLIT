<#
.SYNOPSIS
    Sarkari Kaam (Execution, Smart Build, Canary Smoke-Test & Rollback) - sarkariKaam.ps1

.DESCRIPTION
    Yeh engine task ka execution karta hai:
      1. Fast Pre-flight Check (TypeScript/Svelte check - syntax error pe 0s exit)
      2. Memory Governor (Dynamic Cargo throttling based on live RAM)
      3. Smart Build (No blind 45s sleep loops for syntax errors)
      4. Staged vs Live Installation (Prevents file locked errors)
      5. Three-Tier Safety: (.exe [Live], .new.exe [Staged], .prev.exe [Rollback])
      6. Canary Smoke Test: Naye binary ko launch karke verify karta hai;
         agar crash hua toh instant AUTO-ROLLBACK kar deta hai!
      7. Go Daemon Health Check & Staging
      8. SQLite Ledger Synchronization (AGENTS.md deploy protocol compliance)
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [pscustomobject]$AgentProfile = $null,
    [ValidateSet('app', 'go', 'both', 'docs')]
    [string]$Scope = 'app',
    [string]$InstallDir = '',
    [int]$Priority = 50,
    [switch]$Emergency,
    [switch]$Launch,
    # Explicit override for the two cases that used to be silent warnings:
    # a tracked-dirty working tree and an -ExpectCommit other than HEAD.
    [switch]$Force,
    [string]$Session = '',
    # -Ci takes the executable from GitHub's runner instead of compiling it
    # here. On this machine a Tauri release build takes twelve minutes, it
    # holds the build lock that every other agent is waiting for, and it ends
    # in rustc exiting 0xffffffff once the RAM runs out. The contract does
    # not move: same ledger, same lock, same canary, same marker, same
    # doctor. Only the compiler does.
    [switch]$Ci,
    [string]$CiRelease = 'ci-latest',
    [string]$CiRepo = '',
    # A full download base, instead of the GitHub release URL. It points the
    # deploy at a self-hosted mirror, and it is what lets the download path
    # be tested against a local server.
    [string]$CiBaseUrl = '',
    # The commit whose artifact this deploy should install. Empty means the
    # commit this working tree is standing on, which is what an agent wants
    # in every ordinary case.
    [string]$ExpectCommit = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot)
$BunnyTools = Join-Path $WorkspaceRoot 'Clipchamp_Bunny\tools'
$LedgerScript = Join-Path $BunnyTools 'deploy-ledger.mjs'
$PinScript = Join-Path $BunnyTools 'pin-taskbar.ps1'
$GoRoot = Join-Path $WorkspaceRoot 'go'

# Shared with the classic deploy path, on purpose. go-build-id.ps1 is the one
# implementation of the daemon's version (a hash of the Go sources) and
# ci-artifact.ps1 is the one implementation of "fetch what CI built and prove
# it is what CI published". Two copies of either would drift, and the drift
# would look like a corrupt download or a stale daemon.
. (Join-Path $BunnyTools 'go-build-id.ps1')
. (Join-Path $BunnyTools 'ci-artifact.ps1')

# The daemon version this work order INTENDED to install. It is compared with
# what is actually on disk before the ledger is told 'shipped' - the check
# that two runs in a row were missing.
$script:IntendedDaemonVersion = $null
# The commit whose CI artifact this work order installs. Set from the
# parameter, and read by Execute-SmartCiBuild.
$script:ExpectCommit = $ExpectCommit
$script:Force = [bool]$Force
$script:Session = $Session
$script:WasDirty = $false
$script:ArtifactCommit = $null
$script:AgentProfile = $AgentProfile
$script:Scope = $Scope

# The same lock the classic deploy path uses. Two agents building and
# installing at the same time is how a half-written executable ends up in
# the install folder, so the lock is not optional - it is the thing that
# makes "one deploy at a time" true even when the queue is bypassed.
$DeployLockDir = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'T9EditorLIT\deploy'
} else {
    Join-Path $WorkspaceRoot '.t9\deploy'
}
$DeployLockPath = Join-Path $DeployLockDir 'deploy.lock'
$EvidenceDir = Join-Path $DeployLockDir 'evidence'

function Wait-DeployLock {
    <#
    .SYNOPSIS
        Take the deploy lock, waiting for whoever holds it.
    .DESCRIPTION
        The file is opened with no sharing, so only one process can hold
        it. The handle is returned and must be kept open for the whole
        deploy - closing it releases the lock.
    #>
    param([int]$TimeoutSeconds = 1800)

    if (-not (Test-Path $DeployLockDir)) {
        New-Item -ItemType Directory -Force -Path $DeployLockDir | Out-Null
    }
    $start = Get-Date
    $waited = 0
    while ($true) {
        try {
            return [IO.File]::Open(
                $DeployLockPath,
                [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None
            )
        } catch {
            if (((Get-Date) - $start).TotalSeconds -ge $TimeoutSeconds) {
                throw "timed out waiting for the deploy lock: $DeployLockPath"
            }
            if ($waited % 20 -eq 0) {
                Write-Host "    [..] waiting for the deploy lock ($waited s)" -ForegroundColor Yellow
            }
            Start-Sleep -Seconds 2
            $waited += 2
        }
    }
}

$DefaultInstallDir = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'Programs\T9EditorLIT'
} else {
    Join-Path $WorkspaceRoot 'dist_installed'
}
if (-not $InstallDir) { $InstallDir = $DefaultInstallDir }
$script:InstallDir = $InstallDir

function Test-SarkariKaamSamePath([string]$Left, [string]$Right) {
    try {
        $l = [IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
        $r = [IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
        return [string]::Equals($l, $r, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

# A custom install folder is a test target. It must never be advertised as the
# user's desktop app: no taskbar pin, no 'shipped' ledger row, and no marker
# that an ordinary `deploy.ps1 -Doctor` would mistake for the live install.
$IsLiveInstall = Test-SarkariKaamSamePath $InstallDir $DefaultInstallDir

$ExeName = 't9-editor-lit.exe'
$PrevExeName = 't9-editor-lit.prev.exe'
$NewExeName = 't9-editor-lit.new.exe'
$DaemonName = 't9cloud.exe'

$LiveExe = Join-Path $InstallDir $ExeName
$PrevExe = Join-Path $InstallDir $PrevExeName
$StageExe = Join-Path $InstallDir $NewExeName
$MarkerFile = Join-Path $InstallDir 'build.json'
$PrevMarkerFile = Join-Path $InstallDir 'build.prev.json'

function Get-Sha256Hash([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-RunningAppProcesses {
    # Return a plain array. The caller wraps the call in @(), which keeps an
    # empty result as an empty array. A unary comma here would instead nest
    # the array, making an empty process list look like one running process
    # and crashing the staging path on `.Id`.
    return @(Get-Process -Name 't9-editor-lit' -ErrorAction SilentlyContinue)
}

function Get-RunningDaemonProcesses {
    return @(Get-Process -Name 't9cloud' -ErrorAction SilentlyContinue)
}

function Invoke-PreflightFastCheck {
    Write-Host "==> [Kaam Stage 1/6] Running Lightning Fast-Lane Verification (TS + Svelte + Cargo)" -ForegroundColor Cyan
    $appDir = Join-Path $WorkspaceRoot 'Clipchamp_Bunny'
    
    # Fast Check A: Frontend TypeScript & Svelte
    Push-Location $appDir
    try {
        Write-Host "    [1/2] Checking Svelte 5 / TypeScript types..." -ForegroundColor DarkGray
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $checkOut = & npx svelte-check --tsconfig ./tsconfig.json --threshold error 2>&1
        $sw.Stop()
        if ($LASTEXITCODE -ne 0) {
            Write-Host "    [x] TypeScript / Svelte Error detected ($($sw.Elapsed.TotalSeconds.ToString('F1'))s):" -ForegroundColor Red
            Write-Host ($checkOut | Out-String) -ForegroundColor Red
            throw "Frontend TypeScript check failed. Fix type errors before building."
        } else {
            Write-Host "    [ok] Frontend types clean ($($sw.Elapsed.TotalSeconds.ToString('F1'))s)" -ForegroundColor Green
        }
    } finally {
        Pop-Location
    }

    # Fast Check B: Rust syntax & type check (Fast syntax check without linking)
    Push-Location (Join-Path $appDir 'src-tauri')
    try {
        # `generate_context!()` embeds `dist/` at compile time, so cargo check
        # only works when a complete frontend build is present. While another
        # agent's build rewrites dist/ (or after an interrupted one) this
        # check reported `error: failed to read asset at ...\dist\...` - a Rust
        # error that did not exist, which failed the deploy for no reason.
        #
        # Rebuilding dist/ here would be worse than the bug: this preflight
        # holds no lock, so it would rewrite dist/ underneath the install that
        # does hold it and could pair a stale frontend with a fresh binary.
        # So the preflight stands down, and the install path - which owns
        # dist/ - does the real verification.
        $distIndex = Join-Path $appDir 'dist\index.html'
        if (-not (Test-Path -LiteralPath $distIndex)) {
            Write-Host "    [..] dist/index.html is missing - a build is probably rewriting it" -ForegroundColor Yellow
            Write-Host '    [ok] frontend types clean; skipping Rust preflight (the locked build verifies Rust for real)' -ForegroundColor Green
            return
        }

        Write-Host "    [2/2] Checking Rust types & borrow checker (cargo check)..." -ForegroundColor DarkGray
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $cargoCheck = & cargo check --quiet 2>&1
        $sw.Stop()
        if ($LASTEXITCODE -ne 0) {
            $cargoText = ($cargoCheck | Out-String)
            if ($cargoText -match 'failed to read asset|failed to load asset') {
                # Same race caught mid-flight: dist/ changed between the check
                # reading it and this process reporting it.
                Write-Host "    [..] dist/ changed during the preflight ($($sw.Elapsed.TotalSeconds.ToString('F1'))s)" -ForegroundColor Yellow
                Write-Host '    [ok] treating as a transient asset race, not a Rust error - the locked build re-checks' -ForegroundColor Green
            } else {
                Write-Host "    [x] Rust compilation error detected ($($sw.Elapsed.TotalSeconds.ToString('F1'))s):" -ForegroundColor Red
                Write-Host $cargoText -ForegroundColor Red
                throw "Rust cargo check failed. Fix compilation errors before building."
            }
        } else {
            Write-Host "    [ok] Rust types & borrow checker clean ($($sw.Elapsed.TotalSeconds.ToString('F1'))s)" -ForegroundColor Green
        }
    } finally {
        Pop-Location
    }
}

function Apply-MemoryGovernor {
    Write-Host "==> [Kaam Stage 2/6] Sarkari Memory Governor" -ForegroundColor Cyan

    # Do NOT kill rustc/link by name here. That "orphan reaper" also killed a
    # perfectly healthy `cargo check` belonging to another agent: with a shared
    # tree, the process name does not tell you whose work it is. Local release
    # compiles are banned by the cargo shim; the governor only throttles.
    [System.GC]::Collect()

    try {
        $freeMb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
        if ($freeMb -lt 2200) {
            Write-Host "    [!] Critical low RAM ($freeMb MB free). Restricting Cargo to 1 job to prevent linker crash." -ForegroundColor Yellow
            $env:CARGO_BUILD_JOBS = '1'
            $env:RUSTFLAGS = "-C link-arg=/MAXILKSIZE:0x10000000"
        } elseif ($freeMb -lt 3500) {
            Write-Host "    [!] Moderate RAM ($freeMb MB free). Restricting Cargo to 2 jobs." -ForegroundColor Yellow
            $env:CARGO_BUILD_JOBS = '2'
        } else {
            Write-Host "    [ok] Sufficient RAM available ($freeMb MB free). Default jobs permitted." -ForegroundColor Green
        }
    } catch {
        $env:CARGO_BUILD_JOBS = '1'
    }
}

function Copy-ItemWithBackoff([string]$Source, [string]$Destination, [int]$MaxRetries = 8) {
    $attempt = 0
    while ($attempt -lt $MaxRetries) {
        $attempt++
        try {
            Copy-Item -Path $Source -Destination $Destination -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -ge $MaxRetries) { throw $_ }
            $backoffMs = [int](200 * [Math]::Pow(1.4, $attempt))
            Write-Host "    [!] File locked by Antivirus/Indexer, waiting ${backoffMs}ms before retry (attempt $attempt/$MaxRetries)..." -ForegroundColor Yellow
            Start-Sleep -Milliseconds $backoffMs
        }
    }
}

function Stop-ProcessSynchronously([object[]]$Processes, [int]$TimeoutMs = 3000) {
    foreach ($proc in $Processes) {
        try {
            if ($proc -is [System.Diagnostics.Process] -and -not $proc.HasExited) {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                $null = $proc.WaitForExit($TimeoutMs)
            }
        } catch {}
    }
}

function Restore-SarkariPreviousBuild {
    <#
    .SYNOPSIS
        Restore .prev.exe and the matching build.prev.json marker.
    .DESCRIPTION
        This is the ONE rollback implementation. It is used by the automatic
        canary rollback and by the explicit `deploy.ps1 -Rollback` path, so a
        manual rollback cannot leave the executable on the old build while
        build.json still advertises the failed new one.

        A rollback is refused while the app is running: Windows holds the
        executable open, and a half-copied exe is worse than an honest error.
    #>
    [CmdletBinding()]
    param(
        [string]$InstallDir = $script:InstallDir,
        [string]$Agent = '',
        [string]$Model = '',
        [string]$WorkId = '',
        [switch]$Force
    )

    $liveExe = Join-Path $InstallDir $script:ExeName
    $prevExe = Join-Path $InstallDir $script:PrevExeName
    $stageExe = Join-Path $InstallDir $script:NewExeName
    $stageDaemon = Join-Path $InstallDir 't9cloud.new.exe'
    $markerPath = Join-Path $InstallDir 'build.json'
    $prevMarkerPath = Join-Path $InstallDir 'build.prev.json'
    $failedExe = Join-Path $InstallDir 't9-editor-lit.failed.exe'
    $failedMarker = Join-Path $InstallDir 'build.failed.json'

    if (-not (Test-Path -LiteralPath $prevExe)) {
        throw "no previous build to restore ($prevExe)"
    }

    $running = @(Get-RunningAppProcesses)
    if ($running.Count -gt 0) {
        throw "the app is running (PID $(($running | ForEach-Object { $_.Id }) -join ', ')); close it before a rollback so the executable is not locked"
    }

    $prevSha = Get-Sha256Hash $prevExe
    if (-not $prevSha) { throw "could not hash the previous build ($prevExe)" }

    $prevMarker = $null
    if (Test-Path -LiteralPath $prevMarkerPath) {
        try {
            $prevMarker = Get-Content -LiteralPath $prevMarkerPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
            if (-not $Force) {
                throw "build.prev.json is unreadable ($($_.Exception.Message)); refusing to restore an unverifiable build without -Force"
            }
            Write-Host "    [!] build.prev.json unreadable; continuing because -Force was given" -ForegroundColor Yellow
        }
    }

    if ($prevMarker -and $prevMarker.PSObject.Properties['appSha256']) {
        $claimedSha = [string]$prevMarker.appSha256
        if ($claimedSha -and $claimedSha -ne $prevSha) {
            if (-not $Force) {
                throw "the rollback shield ($prevSha) does not match build.prev.json ($claimedSha); refusing without -Force"
            }
            Write-Host "    [!] rollback shield does not match build.prev.json; -Force overrides the hash check" -ForegroundColor Yellow
        }
    }

    if ($Agent -or $Model -or $WorkId) {
        # Caller-supplied identity is used below only for the marker/report.
    } elseif ($script:AgentProfile) {
        $p = $script:AgentProfile
        if (-not $Agent -and $p.PSObject.Properties['AgentName']) { $Agent = [string]$p.AgentName }
        if (-not $Model -and $p.PSObject.Properties['ModelName']) { $Model = [string]$p.ModelName }
        if (-not $WorkId -and $p.PSObject.Properties['WorkId']) { $WorkId = [string]$p.WorkId }
    }
    if (-not $Agent) { $Agent = 'manual-rollback' }
    if (-not $Model) { $Model = 'manual-rollback' }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
    if (-not $WorkId) { $WorkId = "SARKARI-ROLLBACK-$stamp" }

    # Keep the rejected build for forensics before replacing it.
    if (Test-Path -LiteralPath $liveExe) {
        try { Copy-ItemWithBackoff -Source $liveExe -Destination $failedExe } catch {
            Write-Host "    [!] could not preserve the failed executable: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    if (Test-Path -LiteralPath $markerPath) {
        try { Copy-Item -LiteralPath $markerPath -Destination $failedMarker -Force -ErrorAction Stop } catch { }
    }

    Write-Host "    restoring $prevExe -> $liveExe" -ForegroundColor DarkGray
    Copy-ItemWithBackoff -Source $prevExe -Destination $liveExe
    $liveSha = Get-Sha256Hash $liveExe
    if ($liveSha -ne $prevSha) {
        throw "restored executable hash mismatch ($liveSha vs $prevSha)"
    }

    # A staged update must not resurrect the build that was just rolled back.
    foreach ($staged in @($stageExe, $stageDaemon)) {
        if (Test-Path -LiteralPath $staged) {
            Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
        }
    }

    $buildId = if ($prevMarker -and $prevMarker.PSObject.Properties['buildId'] -and $prevMarker.buildId) {
        [string]$prevMarker.buildId
    } else {
        "rollback-$stamp"
    }

    $markerData = [ordered]@{}
    if ($prevMarker) {
        foreach ($p in $prevMarker.PSObject.Properties) { $markerData[$p.Name] = $p.Value }
    } else {
        $markerData['schema'] = 1
        $markerData['version'] = '0.1.0'
        $markerData['builtAt'] = (Get-Item -LiteralPath $prevExe).LastWriteTimeUtc.ToString('o')
        $markerData['installedAt'] = (Get-Date).ToUniversalTime().ToString('o')
    }
    $markerData['mode'] = 'live'
    $markerData['appSha256'] = $prevSha
    $markerData['rolledBackAt'] = (Get-Date).ToUniversalTime().ToString('o')
    $markerData['rolledBackBy'] = $Agent
    $markerData['rollbackWorkId'] = $WorkId
    $markerData['buildId'] = $buildId
    $markerJson = $markerData | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($markerPath, $markerJson, (New-Object System.Text.UTF8Encoding($false)))

    Write-Host "    [ok] rollback marker restored ($buildId, $liveSha)" -ForegroundColor Green
    return [pscustomobject]@{
        Sha             = $liveSha
        BuildId         = $buildId
        MarkerFile      = $markerPath
        PreviousBuildId = if ($prevMarker) { [string]$prevMarker.buildId } else { '' }
        RolledBackAt    = $markerData['rolledBackAt']
    }
}

function Invoke-SarkariInstall([object]$BuildOutput) {
    Write-Host "==> [Kaam Stage 4/6] Installing Executable with Canary Rollback Safety" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Get-RunningAppProcesses return @(...) karta hai, aur PowerShell pipeline
    # array ko unroll kar deta hai — 0 process par value $null banti hai, jisse
    # StrictMode me .Count throw kar deta tha. Isliye dobara @() se wrap.
    $appProcs = @(Get-RunningAppProcesses)
    $isAppRunning = ($appProcs.Count -gt 0)
    $installMode = if ($isAppRunning) { 'staged' } else { 'live' }
    $prevMarkerPath = Join-Path $InstallDir 'build.prev.json'

    if ($isAppRunning) {
        Write-Host "    [!] App is currently running (PID $(($appProcs | ForEach-Object { $_.Id }) -join ', '))." -ForegroundColor Yellow
        Write-Host "    Staging update as '$NewExeName' (App top-bar will show 'Update' button)." -ForegroundColor Cyan

        # The update click will replace the live exe with the staged one. The
        # rollback target from that moment must be the build that is live NOW,
        # so snapshot both the exe and its marker before staging.
        if (Test-Path -LiteralPath $LiveExe) {
            try {
                Copy-ItemWithBackoff -Source $LiveExe -Destination $PrevExe
            } catch {
                Write-Host "    [!] Could not refresh the rollback shield: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        if (Test-Path -LiteralPath $MarkerFile) {
            try {
                Copy-Item -LiteralPath $MarkerFile -Destination $prevMarkerPath -Force -ErrorAction Stop
            } catch {
                Write-Host "    [!] Could not snapshot build.prev.json: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }

        Copy-ItemWithBackoff -Source $BuildOutput.BuiltExe -Destination $StageExe
        $stageSha = Get-Sha256Hash $StageExe
        if ($stageSha -ne $BuildOutput.BuiltSha) {
            throw "Staged exe hash mismatch ($stageSha vs $($BuildOutput.BuiltSha))"
        }
        Write-Host "    [ok] Staged binary successfully verified ($stageSha)" -ForegroundColor Green
    } else {
        # App is closed - Prepare .prev.exe and its matching marker for
        # rollback safety. Installing without a working shield used to be a
        # warning; now it is a refusal, because the canary cannot undo a bad
        # build without it.
        if (Test-Path $LiveExe) {
            Write-Host "    Creating backup of current version -> '$PrevExeName' (Rollback Shield)" -ForegroundColor DarkGray
            try {
                Copy-ItemWithBackoff -Source $LiveExe -Destination $PrevExe
            } catch {
                throw "could not create the rollback shield ($PrevExe): $($_.Exception.Message). Refusing to install a build that cannot be rolled back."
            }
            if (Test-Path -LiteralPath $MarkerFile) {
                try {
                    Copy-Item -LiteralPath $MarkerFile -Destination $prevMarkerPath -Force -ErrorAction Stop
                } catch {
                    Write-Host "    [!] Could not snapshot build.prev.json: $($_.Exception.Message)" -ForegroundColor Yellow
                }
            }
        }

        Write-Host "    Installing fresh binary in place -> '$LiveExe'" -ForegroundColor Cyan
        Copy-ItemWithBackoff -Source $BuildOutput.BuiltExe -Destination $LiveExe
        $liveSha = Get-Sha256Hash $LiveExe
        if ($liveSha -ne $BuildOutput.BuiltSha) {
            throw "Live exe hash mismatch ($liveSha vs $($BuildOutput.BuiltSha))"
        }
        Write-Host "    [ok] Live binary installed and hash verified ($liveSha)" -ForegroundColor Green

        # ---------------- CANARY SMOKE TEST ----------------
        Write-Host "==> [Kaam Stage 5/6] Canary Smoke Test Verification" -ForegroundColor Cyan
        Write-Host "    Launching canary test to ensure newly installed binary doesn't panic on startup..." -ForegroundColor DarkGray
        
        $canaryPass = $true
        try {
            $canaryProc = Start-Process -FilePath $LiveExe -ArgumentList @('--version') -WindowStyle Hidden -PassThru -ErrorAction Stop
            $waited = 0
            while (-not $canaryProc.HasExited -and $waited -lt 4) {
                Start-Sleep -Seconds 1
                $waited++
            }
            if (-not $canaryProc.HasExited) {
                # App stayed alive cleanly, shut down canary
                Stop-Process -Id $canaryProc.Id -Force -ErrorAction SilentlyContinue
                Write-Host "    [ok] Canary test PASSED: Binary launched cleanly without panic" -ForegroundColor Green
            } else {
                if ($canaryProc.ExitCode -eq 0) {
                    Write-Host "    [ok] Canary test PASSED (Exit code 0)" -ForegroundColor Green
                } else {
                    # A non-zero exit IS the panic signal. This used to print a
                    # warning and carry on, so a binary that died on startup
                    # was installed as a successful deploy.
                    Write-Host "    [x] Canary process exited with code $($canaryProc.ExitCode)" -ForegroundColor Red
                    $canaryPass = $false
                }
            }
        } catch {
            Write-Host "    [x] Canary test FAILED: Process crashed on start! Initiating Instant Rollback..." -ForegroundColor Red
            $canaryPass = $false
        }

        if (-not $canaryPass) {
            $rollbackNote = 'no previous build existed, so no automatic rollback was possible'
            if (Test-Path -LiteralPath $PrevExe) {
                Write-Host "    >>> SARKARI EMERGENCY AUTO-ROLLBACK TRIGGERED <<<" -ForegroundColor Red
                try {
                    $restored = Restore-SarkariPreviousBuild -InstallDir $InstallDir -Force
                    $rollbackNote = "restored the previous build $($restored.BuildId) ($($restored.Sha))"
                    Write-Host "    [ok] Successfully restored previous stable binary from '$PrevExeName'" -ForegroundColor Green
                } catch {
                    $rollbackNote = "AUTOMATIC ROLLBACK FAILED: $($_.Exception.Message)"
                    Write-Host "    [x] $rollbackNote" -ForegroundColor Red
                }
            }

            # Issue Official Court Challan
            $courtScript = Join-Path $PSScriptRoot 'sarkariCourt.ps1'
            if (Test-Path $courtScript) {
                . $courtScript
                $panicAgent = if ($script:AgentProfile -and $script:AgentProfile.AgentName) { $script:AgentProfile.AgentName } else { 'unknown-agent' }
                $panicWork = if ($script:AgentProfile -and $script:AgentProfile.WorkId) { $script:AgentProfile.WorkId } else { 'UNKNOWN-WORK' }
                $null = Issue-SarkariChallan -WorkId $panicWork -Agent $panicAgent -Violation 'CANARY_STARTUP_PANIC' -Description "New executable crashed during startup verification. $rollbackNote."
            }
            throw "Canary smoke test failed. $rollbackNote."
        }
    }

    # The marker is an audit record, not a place for placeholders. A profile
    # without an identity used to write "Agent / Model / WORK-LIVE" into
    # build.json, which is exactly the false attribution this hardening is
    # meant to remove. Refuse instead.
    $aName = if ($script:AgentProfile -and $script:AgentProfile.AgentName) { [string]$script:AgentProfile.AgentName } else { '' }
    $mName = if ($script:AgentProfile -and $script:AgentProfile.ModelName) { [string]$script:AgentProfile.ModelName } else { '' }
    $wId   = if ($script:AgentProfile -and $script:AgentProfile.WorkId) { [string]$script:AgentProfile.WorkId } else { '' }
    if (-not $aName -or -not $mName -or -not $wId) {
        throw 'refusing to write build.json without a real agent, model and work order id'
    }

    # Write build marker build.json
    $markerData = [ordered]@{
        schema         = 1
        # The app's InstalledBuild struct reads `version`; without it the marker
        # fails to parse and the Update button never appears.
        version        = '0.1.0'
        buildId        = $BuildOutput.Manifest.buildId
        builtAt        = $BuildOutput.Manifest.builtAt
        appSha256      = $BuildOutput.BuiltSha
        installedAt    = (Get-Date).ToUniversalTime().ToString('o')
        mode           = $installMode
        agent          = $aName
        model          = $mName
        workId         = $wId
        scope          = $script:Scope
        gitCommit      = $BuildOutput.Manifest.gitCommit
        gitBranch      = $BuildOutput.Manifest.gitBranch
        gitDirty       = [bool]$script:WasDirty
        source         = 'ci'
        ciRunUrl       = $BuildOutput.Manifest.ciRunUrl
        host           = $env:COMPUTERNAME
    }
    $markerJson = $markerData | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($MarkerFile, $markerJson, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "    [ok] build.json marker updated (Mode: $installMode)" -ForegroundColor Green

    # Start menu / Taskbar pin refresh. A custom install folder is a test
    # target; repinning the user's real taskbar to it would be a live change
    # disguised as a test.
    if (-not $IsLiveInstall) {
        Write-Host '    [..] custom install folder - taskbar/Start menu pinning skipped (test target)' -ForegroundColor Yellow
    } elseif (Test-Path $PinScript) {
        Write-Host "    [ok] Updating Start menu / taskbar shortcut..." -ForegroundColor DarkGray
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $PinScript -InstallDir $InstallDir 2>$null | Out-Null
    }

    return [pscustomobject]@{
        InstallMode   = $installMode
        IsTestInstall = (-not $IsLiveInstall)
        BuildId       = $BuildOutput.Manifest.buildId
        GitCommit     = $BuildOutput.Manifest.gitCommit
        LiveExe       = $LiveExe
        LiveSha       = Get-Sha256Hash $LiveExe
        StageExe      = $StageExe
        StageSha      = Get-Sha256Hash $StageExe
        PrevExe       = $PrevExe
        MarkerFile    = $MarkerFile
    }
}

function Execute-SmartCiBuild([string]$BuildId) {
    # The compile happened on GitHub's runner. This function only fetches the
    # result and proves it is the one CI published - the SHA-256 in the
    # manifest is the contract, exactly as the local build's manifest is.
    Write-Host "==> [Kaam Stage 3/6] Smart Build Pipeline Trigger ($BuildId, from CI)" -ForegroundColor Cyan
    $ciRoot = Join-Path $WorkspaceRoot '.t9\ci'

    # Which commit's build is this deploy installing? By default, the one
    # this working tree is standing on.
    #
    # This matters as soon as there is more than one agent. The rolling
    # release moves every time anyone pushes, so an agent that pushed at
    # 10:00 and deploys at 10:10 would be handed the build of whatever
    # somebody else pushed at 10:05 - and the record would say it shipped
    # their work. So the deploy waits for ITS OWN commit's artifact. The
    # rolling release is still used, but only when it holds exactly that
    # commit.
    $headAtStart = (& git -C $WorkspaceRoot rev-parse HEAD 2>$null | Select-Object -First 1)
    $headAtStart = ([string]$headAtStart).Trim()

    # -ExpectCommit is a promise about the binary, not a suggestion. If the
    # caller names a different commit than the tree is standing on, that is a
    # deliberate old-build install (or a mistake), and it needs -Force and a
    # recorded reason. It used to be accepted silently.
    if ($script:ExpectCommit -and $headAtStart) {
        $expShort = $script:ExpectCommit.Substring(0, [Math]::Min(7, $script:ExpectCommit.Length))
        $headShort = $headAtStart.Substring(0, [Math]::Min(7, $headAtStart.Length))
        if ($expShort -ne $headShort -and -not $script:Force) {
            throw "refusing -ExpectCommit $expShort while HEAD is $headShort. Commit/push the current tree or pass -Force for a deliberate old-build install."
        }
    }

    $wanted = $script:ExpectCommit
    if (-not $wanted) { $wanted = $headAtStart }
    $wanted = ([string]$wanted).Trim()
    if ($wanted) {
        $wantedShort = $wanted.Substring(0, [Math]::Min(7, $wanted.Length))
        Write-Host "    the artifact of commit $wantedShort is the one this deploy will install" -ForegroundColor DarkGray
    } else {
        $wantedShort = ''
    }

    $artifact = $null
    $deadline = (Get-Date).AddMinutes(12)
    while ($true) {
        if ($wanted) {
            $artifact = Get-SarkariCiArtifact -Repo $CiRepo -Release $CiRelease `
                -DestinationRoot $ciRoot -WorkspaceRoot $WorkspaceRoot -BaseUrl $CiBaseUrl `
                -Commit $wanted -AllowMissing
        } else {
            $artifact = Get-SarkariCiArtifact -Repo $CiRepo -Release $CiRelease `
                -DestinationRoot $ciRoot -WorkspaceRoot $WorkspaceRoot -BaseUrl $CiBaseUrl `
                -AllowMissing
        }
        if ($artifact) { break }

        # There is deliberately NO fallback to the rolling release here.
        #
        # The rolling release is a pointer, and pointers move - while the
        # assets under them are being replaced. A deploy that fetched the
        # manifest a moment before another agent's build replaced the assets
        # got a 404 for a file it had just read, and the whole deploy died
        # on somebody else's publish. It happened, in a real run.
        #
        # The per-commit release is a fact: it never moves, so it can be
        # fetched safely, as many times as it takes. If it is not there yet,
        # the answer is to wait for it - which is what this loop does.
        if ((Get-Date) -gt $deadline) {
            if ($wanted) {
                throw "CI has not published the artifact for commit $wantedShort yet - push your work, wait for the run to finish, and deploy again. The artifact workflow queues instead of cancelling, so it will arrive."
            }
            throw "CI has not published a 'ci-latest' artifact yet - push your work and wait for the run to finish, then deploy again."
        }
        Write-Host '    CI has not published that build yet - waiting (this is normal right after a push)' -ForegroundColor DarkGray
        Start-Sleep -Seconds 20
    }

    # The local manifest and the CI manifest are given the same shape here, so
    # the install, the marker and the doctor do not need to know where the
    # binary came from.
    $normalized = [pscustomobject]@{
        schema    = 1
        buildId   = $artifact.BuildId
        builtAt   = [string](Get-SarkariCiProp $artifact.Manifest 'builtAt')
        exe       = $artifact.ExePath
        sha256    = $artifact.ExeSha
        size      = (Get-Item -LiteralPath $artifact.ExePath).Length
        gitCommit = $artifact.GitCommit
        gitBranch = [string](Get-SarkariCiProp $artifact.Manifest 'gitBranch')
        source    = 'ci'
        ciRunUrl  = $artifact.RunUrl
    }

    if ($artifact.RunUrl) { Write-Host "    [ok] CI run: $($artifact.RunUrl)" -ForegroundColor Green }

    if (-not $artifact.GitCommit) {
        throw 'the CI artifact does not say which commit it was built from; refusing to install an unprovable binary'
    }
    $script:ArtifactCommit = [string]$artifact.GitCommit

    if ($script:ExpectCommit) {
        $expShort = $script:ExpectCommit.Substring(0, [Math]::Min(7, $script:ExpectCommit.Length))
        $artShort = $script:ArtifactCommit.Substring(0, [Math]::Min(7, $script:ArtifactCommit.Length))
        if ($expShort -ne $artShort) {
            throw "the artifact is from commit $artShort, but -ExpectCommit asked for $expShort; refusing to install the wrong build"
        }
    }

    # The installed binary is built from a COMMIT. A tracked-dirty tree means
    # the source on disk is not the source in the binary; that used to be a
    # warning. It is now a refusal unless the operator says -Force, and the
    # marker records the dirty state so nobody can call it clean later.
    $head = (& git -C $WorkspaceRoot rev-parse HEAD 2>$null | Select-Object -First 1)
    $head = ([string]$head).Trim()
    if ($artifact.GitCommit -and $head -and $artifact.GitCommit -ne $head) {
        Write-Host "    [!] the CI build is from commit $($artifact.GitCommit) but HEAD moved to $head during the wait" -ForegroundColor Yellow
    }
    $dirtyTracked = @(& git -C $WorkspaceRoot status --porcelain --untracked-files=no 2>$null)
    if ($dirtyTracked.Count -gt 0) {
        if (-not $script:Force) {
            $preview = ($dirtyTracked | Select-Object -First 8) -join '; '
            throw "the tracked working tree is dirty ($($dirtyTracked.Count) file(s)): $preview. CI builds from the commit, so these edits are NOT in the binary. Commit them or pass -Force to record a dirty install deliberately."
        }
        $script:WasDirty = $true
        Write-Host "    [!] tracked working tree is dirty ($($dirtyTracked.Count) file(s)); -Force given, marker will record gitDirty=true" -ForegroundColor Yellow
    }

    return [pscustomobject]@{
        ManifestPath = $artifact.ManifestPath
        Manifest     = $normalized
        BuiltExe     = $artifact.ExePath
        BuiltSha     = $artifact.ExeSha
        CiArtifact   = $artifact
    }
}

function Install-SarkariDaemon([object]$BuildOutput) {
    # The Go half of a work order.
    #
    # It used to live only in the classic deploy path, which meant the live
    # path never rebuilt the daemon at all: two deploys in a row reported
    # SHIPPED while t9cloud.exe stayed exactly as it was, and nothing in the
    # record said so. Here the daemon is built (or taken from CI), installed,
    # and its version is checked - so "the Go half shipped" is something the
    # ledger can finally stand behind.
    if ($Scope -notin @('go', 'both')) { return $null }

    $daemonName = 't9cloud.exe'
    $liveDaemon = Join-Path $InstallDir $daemonName
    $stageDaemon = Join-Path $InstallDir 't9cloud.new.exe'
    $source = $null
    $intended = $null

    $ci = $null
    if ($BuildOutput -and $BuildOutput.PSObject.Properties['CiArtifact'] -and $BuildOutput.CiArtifact) {
        $ci = $BuildOutput.CiArtifact
    }

    if ($ci -and $ci.DaemonPath) {
        $source = $ci.DaemonPath
        $intended = $ci.DaemonVersion
        Write-Host "    [ok] daemon taken from CI ($intended)" -ForegroundColor Green
    } else {
        # There is deliberately no local `go build` fallback. CI builds the
        # daemon from the same commit as the app; a local build would use the
        # working tree, which may contain uncommitted Go edits, and would let a
        # `go` work order install code that is not in the commit the ledger
        # recorded. If the artifact has no daemon, that is a CI bug to fix.
        throw "the CI artifact for this commit does not carry t9cloud.exe. Refusing a local Go build: the daemon is built in CI, from the same commit as the app."
    }

    $version = ((& $source -version) | Out-String).Trim() -split '\s+' | Select-Object -Last 1
    if ($intended -and $version -ne $intended) {
        throw "the daemon reports version '$version', expected '$intended'"
    }
    $script:IntendedDaemonVersion = $intended

    # Live when the daemon is not running, staged when it is - the same rule
    # the app follows, so the Update click swaps both.
    $running = @(Get-RunningDaemonProcesses)
    if ($running.Count -gt 0) {
        Copy-ItemWithBackoff -Source $source -Destination $stageDaemon
        Write-Host "    [!] the daemon is running - staged as '$(Split-Path -Leaf $stageDaemon)'; the Update click swaps it" -ForegroundColor Yellow
        return [pscustomobject]@{ Mode = 'staged'; Version = $version; Path = $stageDaemon; Sha = Get-Sha256Hash $stageDaemon }
    }
    Copy-ItemWithBackoff -Source $source -Destination $liveDaemon
    $installedSha = Get-Sha256Hash $liveDaemon
    Write-Host "    [ok] daemon installed and verified ($version, $installedSha)" -ForegroundColor Green
    return [pscustomobject]@{ Mode = 'live'; Version = $version; Path = $liveDaemon; Sha = $installedSha }
}

function Execute-SarkariKaam {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$false)]
        [pscustomobject]$AgentProfile = $null,
        [string]$Scope = '',
        [string]$InstallDir = '',
        [int]$Priority = 50,
        [switch]$Emergency,
        [switch]$Launch,
        [switch]$Ci,
        [string]$ExpectCommit = '',
        [switch]$Force,
        [string]$Session = ''
    )

    if ($ExpectCommit) { $script:ExpectCommit = $ExpectCommit }
    $script:Force = [bool]$Force
    $script:Session = $Session
    # The caller's catch needs to see the claimed order even if this function
    # dies later (daemon gate, ledger finish, etc.). It is cleared only after
    # the order is actually closed.
    $script:ActiveLedgerOrder = $null

    if ($AgentProfile) {
        $script:AgentProfile = $AgentProfile
    }
    $script:Scope = $Scope
    if ($InstallDir) {
        $script:InstallDir = $InstallDir
        $script:LiveExe = Join-Path $InstallDir $script:ExeName
        $script:PrevExe = Join-Path $InstallDir $script:PrevExeName
        $script:StageExe = Join-Path $InstallDir $script:NewExeName
        $script:MarkerFile = Join-Path $InstallDir 'build.json'
    }

    Write-Host "`n========================================================" -ForegroundColor Green
    Write-Host "  SARKARI KAAM EXECUTION PIPELINE STARTED" -ForegroundColor Green
    Write-Host "========================================================" -ForegroundColor Green

    # Refuse an unprofiled deploy. This used to generate a random WorkId and
    # continue, which meant any script that called Execute-SarkariKaam directly
    # could install without a form, a claim, or a queue position. The only
    # supported door is tools\deploy.ps1, and it always supplies a profile.
    $rawProfile = $script:AgentProfile
    $hasWorkId = $false
    $resolvedWorkId = ''
    if ($null -ne $rawProfile) {
        $workIdProp = $rawProfile.PSObject.Properties['WorkId']
        if ($workIdProp -and $workIdProp.Value) {
            $hasWorkId = $true
            $resolvedWorkId = [string]$workIdProp.Value
        }
    }
    if (-not $hasWorkId) {
        $profileType = if ($null -eq $rawProfile) { 'null' } else { $rawProfile.GetType().FullName }
        $propNames = if ($null -ne $rawProfile) {
            (($rawProfile.PSObject.Properties | ForEach-Object { $_.Name }) -join ', ')
        } else { '<none>' }
        throw "refusing an unprofiled deploy (profile type: $profileType; properties: $propNames). Use tools\deploy.ps1, which creates a WorkId and a ledger order; Execute-SarkariKaam will not invent one."
    }

    # A WorkId alone is not a profile. The form validates these fields, but a
    # script could call Execute-SarkariKaam directly with a hand-made object.
    # Refuse the blank/fake shape here too, so no path can acquire a queue slot
    # with an invented agent, model, task, reason or ETA.
    $profileAgentProp = $rawProfile.PSObject.Properties['AgentName']
    $profileModelProp = $rawProfile.PSObject.Properties['ModelName']
    $profileTaskProp = $rawProfile.PSObject.Properties['Task']
    $profileWhyProp = $rawProfile.PSObject.Properties['Why']
    $profileEtaProp = $rawProfile.PSObject.Properties['EtaMinutes']
    $profileAgent = if ($profileAgentProp) { ([string]$profileAgentProp.Value).Trim() } else { '' }
    $profileModel = if ($profileModelProp) { ([string]$profileModelProp.Value).Trim() } else { '' }
    $profileTask = if ($profileTaskProp) { ([string]$profileTaskProp.Value).Trim() } else { '' }
    $profileWhy = if ($profileWhyProp) { ([string]$profileWhyProp.Value).Trim() } else { '' }
    $profileEta = 0
    if ($profileEtaProp) {
        try { $profileEta = [int]$profileEtaProp.Value } catch { $profileEta = 0 }
    }
    if ($resolvedWorkId.Length -lt 8) {
        throw "refusing a deploy with the placeholder WorkId '$resolvedWorkId'. Use tools\deploy.ps1; it creates a real work order."
    }
    if ($profileAgent.Length -lt 2) {
        throw "refusing a deploy profile without a real AgentName. Use tools\deploy.ps1; it records the agent that is actually deploying."
    }
    if ($profileModel.Length -lt 3) {
        throw "refusing a deploy profile without a real ModelName. Use tools\deploy.ps1; it records the exact provider/model id."
    }
    if ($profileTask.Length -lt 8) {
        throw "refusing a deploy profile without a real Task (8+ characters). Use tools\deploy.ps1; the task is part of the work order."
    }
    if ($profileWhy.Length -lt 15) {
        throw "refusing a deploy profile without a real Why (15+ characters). Use tools\deploy.ps1; the reason is part of the work order."
    }
    if ($profileEta -lt 1 -or $profileEta -gt 480) {
        throw "refusing a deploy profile without a real ETA (1..480 minutes). A default ETA is not honest."
    }

    # A docs-only order does not install a binary, so it does not need a
    # compile preflight. Running one would make a typo in unrelated code block
    # a documentation change.
    if ($script:Scope -eq 'docs') {
        Write-Host '    [..] docs scope: skipping app preflight; no binary will be installed' -ForegroundColor DarkGray
    } else {
        Invoke-PreflightFastCheck
        Apply-MemoryGovernor
    }

    # ---- the shared SQLite queue ----------------------------------------
    # AGENTS.md: "Ledger hi sach hai". The Sarkari engine has its own JSON
    # records, but the *queue* - who is deploying right now, whose turn is
    # it - lives in the SQLite ledger that docs/AGENT_DEPLOY_PROTOCOL.md is
    # written against. So the work order is queued and claimed there too.
    . (Join-Path $PSScriptRoot 'sarkariLedger.ps1')
    $ledgerOrder = $null
    $ledgerClaimed = $false

    # Provenance is recorded at request time, not guessed later. These three
    # values used to be blank in the ledger, which made it impossible to tell
    # which commit a "shipped" row actually described.
    $requestHead = (& git -C $WorkspaceRoot rev-parse HEAD 2>$null | Select-Object -First 1)
    $requestHead = ([string]$requestHead).Trim()
    $requestBranch = (& git -C $WorkspaceRoot rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1)
    $requestBranch = ([string]$requestBranch).Trim()
    $requestDirty = @(& git -C $WorkspaceRoot status --porcelain --untracked-files=no 2>$null).Count -gt 0

    if ($null -ne $rawProfile) {
        # StrictMode: a profile built by an older/other path may not carry
        # this field, and a bare `$rawProfile.AllottedMinutes` would abort the
        # deploy at exactly the point where it is supposed to start building.
        $leaseMinutes = 30
        $leaseProp = $rawProfile.PSObject.Properties['AllottedMinutes']
        if ($leaseProp -and $leaseProp.Value) {
            try { $leaseMinutes = [int]$leaseProp.Value } catch { $leaseMinutes = 30 }
        }
        if ($leaseMinutes -le 0) { $leaseMinutes = 30 }

        $ledgerOrder = New-SarkariLedgerOrder -AgentProfile $rawProfile -Scope $script:Scope `
            -Priority $Priority -Emergency:$Emergency -Session $script:Session `
            -Commit $requestHead -Branch $requestBranch -GitDirty:$requestDirty -GitClean:(-not $requestDirty)
        if ($ledgerOrder) {
            # Publish it to the caller now. If Start-SarkariLedgerOrder or the
            # deploy-lock wait throws, sarkariDeploy's catch can still close
            # the queue slot instead of leaving it active for 30 minutes.
            $script:ActiveLedgerOrder = $ledgerOrder
            # Start-SarkariLedgerOrder keeps the token owner and attaches the
            # claim metadata (run id, state) to it, so the heartbeat and
            # finish steps below still have the token they need.
            $claimed = Start-SarkariLedgerOrder -Order $ledgerOrder `
                -LeaseMinutes $leaseMinutes `
                -MaxWaitMinutes ([math]::Max(5, $leaseMinutes))
            if ($claimed) { $ledgerClaimed = $true }
        }

        if (-not $ledgerClaimed) {
            # The ledger can hiccup (this box runs at ~1 GB free RAM), but a
            # failed claim must not become a queue bypass. If another order is
            # active or waiting, refuse; the deploy lock is not a substitute
            # for the fair queue. Only a genuinely empty/unreadable ledger may
            # continue, loudly and without a lease.
            $busy = $false
            try {
                $status = Invoke-SarkariLedger -Arguments @('status', '--json')
                if ($status) {
                    if ($status.active) { $busy = $true }
                    if ($null -ne $status.queueDepth -and [int]$status.queueDepth -gt 0) { $busy = $true }
                }
            } catch { }
            if ($busy) {
                throw "the ledger is busy (another order is active or queued), but this order could not claim its slot. Refusing to jump the queue; retry after the active deploy finishes."
            }
            $reason = if ($ledgerOrder) { "could not claim $($ledgerOrder.workId)" } else { 'no work order was issued' }
            Write-Host "    [!] proceeding WITHOUT a ledger lease ($reason)" -ForegroundColor Yellow
            Write-Host '    [!] the deploy lock still serialises installs, so this cannot corrupt an executable' -ForegroundColor Yellow
        }
    }

    $buildId = "app-$($resolvedWorkId.ToLowerInvariant())"

    # The CI wait can take minutes, and the ledger's lease has to be kept
    # alive while it runs - otherwise the queue thinks the deploy died and
    # lets somebody else in front of it.
    $heartbeatJob = $null
    if ($ledgerOrder -and $ledgerClaimed) {
        # The heartbeat has to go through the ledger's CLI, not through the
        # PowerShell helper - the helper is a set of functions, not a command.
        # (Calling the helper as a script silently did nothing, and the lease
        # then expired under a build that was perfectly alive.)
        # Only an order that actually holds the lease needs one: heartbeating
        # an order that was never claimed just keeps a queued row alive in
        # front of the agents that are legitimately waiting their turn.
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
        if ($nodeCommand -and (Test-Path $LedgerScript)) {
            $heartbeatJob = Start-Job -ScriptBlock {
                param($Node, $Cli, $Id, $Token)
                while ($true) {
                    Start-Sleep -Seconds 45
                    try {
                        & $Node $Cli heartbeat --id $Id --token $Token --phase building --json | Out-Null
                    } catch {
                        # The ledger going away for a moment is not worth
                        # killing the build over.
                    }
                }
            } -ArgumentList $nodeCommand.Source, $LedgerScript, $ledgerOrder.workId, $ledgerOrder.token
        }
    }

    # The deploy lock. It is taken *after* the queue claim, so the agent
    # that is next in line is already known, and it is held for the whole
    # build and install - the two windows where a half-written executable
    # could otherwise land in the install folder.
    $deployLock = $null
    try {
        $deployLock = Wait-DeployLock
        Write-Host "    [ok] deploy lock held ($DeployLockPath)" -ForegroundColor Green
    } catch {
        throw "deploy lock could not be taken: $($_.Exception.Message)"
    }

    try {
        # There is no local build any more. The compile happens in CI, on
        # GitHub's runner, and this machine only verifies a hash and
        # installs. That is not a style choice: a release build here took six
        # to twelve minutes, held the build lock that every other agent was
        # waiting behind, and died in the linker for want of memory. It was
        # the reason five agents could not work at once.
        $buildOutput = $null
        $installOutput = $null
        $daemonOutput = $null

        if ($script:Scope -eq 'docs') {
            # Documentation does not change a binary. It still gets a ledger
            # row and the commit is recorded, but it must not install the app
            # and then claim the app half shipped.
            $buildId = "docs-$($resolvedWorkId.ToLowerInvariant())"
            $installOutput = [pscustomobject]@{
                InstallMode   = 'docs'
                IsTestInstall = $false
                BuildId       = $buildId
                GitCommit     = $requestHead
                LiveExe       = $null
                LiveSha       = $null
                StageExe      = $null
                StageSha      = $null
                PrevExe       = $null
                MarkerFile    = $null
            }
        } else {
            $buildOutput = Execute-SmartCiBuild -BuildId $buildId
            $buildId = [string]$buildOutput.Manifest.buildId

            if ($script:Scope -in @('app', 'both')) {
                $installOutput = Invoke-SarkariInstall -BuildOutput $buildOutput
            } else {
                # A `go` order installs the daemon only. It used to install the
                # app as a side effect of sharing this pipeline, which meant a
                # Go-only work order could replace the UI without an app review.
                $installOutput = [pscustomobject]@{
                    InstallMode   = 'daemon'
                    IsTestInstall = (-not $IsLiveInstall)
                    BuildId       = $buildId
                    GitCommit     = $buildOutput.Manifest.gitCommit
                    LiveExe       = $null
                    LiveSha       = $null
                    StageExe      = $null
                    StageSha      = $null
                    PrevExe       = $null
                    MarkerFile    = $null
                }
            }

            $daemonOutput = Install-SarkariDaemon -BuildOutput $buildOutput
        }
    } catch {
        # A failed deploy has to release its queue slot. Leaving the order
        # 'active' keeps a dead work order sitting in front of the agents
        # that are legitimately waiting their turn - and the queue is the
        # thing every other agent is looking at to know where they stand.
        # It happened: a deploy that failed on a missing CI release left its
        # order active, and the deploy lock was free but the queue was not.
        if ($ledgerOrder -and $ledgerClaimed) {
            try {
                $null = Complete-SarkariLedgerOrder -Order $ledgerOrder -Outcome 'failed' `
                    -Mode 'failed' -BuildId $buildId -ErrorText $_.Exception.Message
                $script:ActiveLedgerOrder = $null
                Write-Host "    [ok] the failed work order was closed: $($ledgerOrder.workId)" -ForegroundColor Green
            } catch {
                Write-Host "    [!] could not close the failed work order: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        throw
    } finally {
        if ($heartbeatJob) {
            Stop-Job -Job $heartbeatJob -ErrorAction SilentlyContinue
            Remove-Job -Job $heartbeatJob -Force -ErrorAction SilentlyContinue
        }
        if ($deployLock) {
            $deployLock.Close()
            $deployLock.Dispose()
        }
    }

    if ($Launch -and $installOutput.InstallMode -eq 'live') {
        Write-Host "==> Starting installed app as requested (-Launch)..." -ForegroundColor Cyan
        Start-Process -FilePath $LiveExe
    }

    # The daemon gate.
    #
    # A 'go' or 'both' work order promises the Go half, and the only honest
    # way to record that promise is to compare the daemon that is actually on
    # disk against the one this work order intended to install. Two deploys
    # in a row reported SHIPPED with t9cloud.exe untouched, because nothing
    # in the live path ever compared the two.
    #
    # A staged daemon counts: the Update click swaps it, exactly as it swaps
    # the app. What does not count is a daemon that is merely present.
    if ($Scope -in @('go', 'both')) {
        $intended = $script:IntendedDaemonVersion
        if (-not $intended) {
            throw "scope '$Scope' promises the t9cloud daemon, but no daemon was chosen for this work order, so there is nothing to claim as shipped."
        }
        $found = $null
        foreach ($candidate in @((Join-Path $InstallDir 't9cloud.exe'), (Join-Path $InstallDir 't9cloud.new.exe'))) {
            if (Test-Path -LiteralPath $candidate) {
                try {
                    $v = ((& $candidate -version) | Out-String).Trim() -split '\s+' | Select-Object -Last 1
                    if ($v -eq $intended) { $found = $candidate; break }
                } catch { }
            }
        }
        if (-not $found) {
            throw "scope '$Scope' promises the t9cloud daemon, but neither the installed nor the staged daemon carries version '$intended'. The Go changes were NOT deployed, so this is not shipped."
        }
        Write-Host "    [ok] daemon verified ($intended)" -ForegroundColor Green
    }

    # Attach the daemon half to build.json after it is installed. The marker
    # used to be written before the daemon step and never updated, so a `both`
    # work order could ship a daemon that build.json knew nothing about.
    if ($daemonOutput -and $installOutput.MarkerFile -and (Test-Path -LiteralPath $installOutput.MarkerFile)) {
        try {
            $markerObject = Get-Content -LiteralPath $installOutput.MarkerFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $markerObject | Add-Member -NotePropertyName daemonBuildId -NotePropertyValue $script:IntendedDaemonVersion -Force
            $markerObject | Add-Member -NotePropertyName daemonVersion -NotePropertyValue $daemonOutput.Version -Force
            $markerObject | Add-Member -NotePropertyName daemonSha256 -NotePropertyValue $daemonOutput.Sha -Force
            $markerObject | Add-Member -NotePropertyName daemonMode -NotePropertyValue $daemonOutput.Mode -Force
            $markerJson = $markerObject | ConvertTo-Json -Depth 8
            [System.IO.File]::WriteAllText($installOutput.MarkerFile, $markerJson, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "    [ok] marker records the daemon half ($($daemonOutput.Version))" -ForegroundColor DarkGray
        } catch {
            Write-Host "    [!] could not attach daemon details to build.json: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    # Evidence is the machine-readable half of the ledger row: which artifact,
    # which commit, which hashes, which marker. The ledger stores the path and
    # parses these fields into the run record.
    $evidencePath = $null
    try {
        New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
        $markerEvidence = $null
        if ($installOutput.MarkerFile -and (Test-Path -LiteralPath $installOutput.MarkerFile)) {
            try {
                $markerEvidence = Get-Content -LiteralPath $installOutput.MarkerFile -Raw -Encoding UTF8 | ConvertFrom-Json
            } catch { $markerEvidence = $null }
        }
        $evidence = [ordered]@{
            schema   = 1
            workId   = $resolvedWorkId
            buildId  = $buildId
            commit   = $(if ($buildOutput) { $buildOutput.Manifest.gitCommit } else { $requestHead })
            branch   = $requestBranch
            gitDirty = [bool]($script:WasDirty -or $requestDirty)
            source   = $(if ($buildOutput) { 'ci' } else { 'git' })
            ciRunUrl = $(if ($buildOutput) { $buildOutput.Manifest.ciRunUrl } else { $null })
            app      = [ordered]@{
                sha256   = $(if ($buildOutput) { $buildOutput.BuiltSha } else { $null })
                artifact = $(if ($buildOutput) { $buildOutput.BuiltExe } else { $null })
            }
            install  = [ordered]@{
                mode          = $installOutput.InstallMode
                isTestInstall = [bool]$installOutput.IsTestInstall
                liveSha256    = $installOutput.LiveSha
                stagedSha256  = $installOutput.StageSha
                markerPath    = $installOutput.MarkerFile
            }
            daemon   = $(if ($daemonOutput) {
                [ordered]@{
                    version = $daemonOutput.Version
                    sha256  = $daemonOutput.Sha
                    mode    = $daemonOutput.Mode
                    path    = $daemonOutput.Path
                }
            } else { $null })
            marker   = $markerEvidence
        }
        $evidencePath = Join-Path $EvidenceDir "$resolvedWorkId.json"
        $evidenceJson = $evidence | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($evidencePath, $evidenceJson, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        $evidencePath = $null
        Write-Host "    [!] could not write deploy evidence: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    # The queue is released here, with the real outcome.
    if ($ledgerOrder) {
        $ledgerOutcome = 'shipped'
        $ledgerMode = $installOutput.InstallMode
        $ledgerError = ''
        if ($installOutput.IsTestInstall) {
            # A custom install folder is a test. The files changed there, but
            # the user's desktop app did not, so the ledger must not say
            # 'shipped'.
            $ledgerOutcome = 'cancelled'
            $ledgerMode = 'test'
            $ledgerError = "test-only install to $InstallDir; the live desktop app was not changed"
            Write-Host "    [!] custom install folder - recording this as a TEST, not a desktop deploy" -ForegroundColor Yellow
        } elseif (-not $ledgerClaimed) {
            # It was queued but never held the lease; close it as cancelled so
            # it stops occupying a queue position the waiting agents can see.
            $ledgerOutcome = 'cancelled'
            $ledgerError = 'built without a lease - the ledger never handed over the slot'
        }

        $null = Complete-SarkariLedgerOrder -Order $ledgerOrder -Outcome $ledgerOutcome `
            -Mode $ledgerMode -BuildId $buildId -Evidence $evidencePath -ErrorText $ledgerError
        $script:ActiveLedgerOrder = $null
    }

    Write-Host "========================================================`n" -ForegroundColor Green

    return [pscustomobject]@{
        Success        = $true
        BuildId        = $buildId
        BuildOutput    = $buildOutput
        InstallOutput  = $installOutput
        DaemonOutput   = $daemonOutput
        LedgerOrder    = $ledgerOrder
        IsTestInstall  = [bool]$installOutput.IsTestInstall
        EvidencePath   = $evidencePath
        GitCommit      = $(if ($buildOutput) { $buildOutput.Manifest.gitCommit } else { $requestHead })
    }
}
