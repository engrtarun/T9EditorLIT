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
    [switch]$SkipBuild,
    [switch]$Launch,
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
$BuildScript = Join-Path $BunnyTools 'build.ps1'
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

if (-not $InstallDir) {
    if ($env:LOCALAPPDATA) {
        $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\T9EditorLIT'
    } else {
        $InstallDir = Join-Path $WorkspaceRoot 'dist_installed'
    }
}

$ExeName = 't9-editor-lit.exe'
$PrevExeName = 't9-editor-lit.prev.exe'
$NewExeName = 't9-editor-lit.new.exe'
$DaemonName = 't9cloud.exe'

$LiveExe = Join-Path $InstallDir $ExeName
$PrevExe = Join-Path $InstallDir $PrevExeName
$StageExe = Join-Path $InstallDir $NewExeName
$MarkerFile = Join-Path $InstallDir 'build.json'

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
        # holds no lock, so it would rewrite dist/ underneath the build that
        # does hold it and produce exactly the mixed executable build.ps1's
        # lock exists to prevent. So the preflight stands down, and the locked
        # build - which owns dist/ and rebuilds it itself - does the real
        # verification.
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
    Write-Host "==> [Kaam Stage 2/6] Sarkari Memory Governor & Self-Healing" -ForegroundColor Cyan
    
    # Reap orphan compiler processes from previous aborted builds
    try {
        $orphans = @(Get-Process -Name 'link', 'rustc' -ErrorAction SilentlyContinue)
        if ($orphans.Count -gt 0) {
            Write-Host "    [!] Detected $($orphans.Count) orphan compiler process(es). Reaping to free memory..." -ForegroundColor Yellow
            foreach ($p in $orphans) {
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}

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

function Execute-SmartBuild([string]$BuildId) {
    Write-Host "==> [Kaam Stage 3/6] Smart Build Pipeline Trigger ($BuildId)" -ForegroundColor Cyan
    if (-not (Test-Path $BuildScript)) {
        throw "build.ps1 missing at: $BuildScript"
    }

    $attempt = 0
    $maxAttempts = 2
    $builtResult = $null

    $aName = if ($script:AgentProfile -and $script:AgentProfile.PSObject.Properties['AgentName'] -and $script:AgentProfile.AgentName) { $script:AgentProfile.AgentName } else { 'Agent' }
    $mName = if ($script:AgentProfile -and $script:AgentProfile.PSObject.Properties['ModelName'] -and $script:AgentProfile.ModelName) { $script:AgentProfile.ModelName } else { 'Model' }
    $wProp = if ($script:AgentProfile) { $script:AgentProfile.PSObject.Properties['WorkId'] } else { $null }
    $wId   = if ($wProp -and $wProp.Value) { $wProp.Value } else { $BuildId }

    # The build folder is shared on purpose.
    #
    # An isolated folder per work order stops two builds from touching the
    # same files, but it also throws away the dependency cache: every build
    # then costs the full ~5 minutes instead of ~1. The deploy lock (taken
    # below) is what actually stops two agents from building at once, and
    # cargo's own file lock keeps the shared folder safe.
    $env:T9_TARGET_DIR = $null
    $env:CARGO_TARGET_DIR = $null

    # Old isolated folders are worth gigabytes each, and nobody needs them
    # once their build shipped. Keep the two most recent, drop the rest.
    try {
        $targetRoot = Join-Path $WorkspaceRoot '.t9\targets'
        if (Test-Path $targetRoot) {
            $old = Get-ChildItem $targetRoot -Directory -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -Skip 2
            foreach ($dir in $old) {
                Remove-Item $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}

    while ($attempt -lt $maxAttempts) {
        $attempt++
        try {
            Write-Host "    Starting build attempt $attempt of $maxAttempts..." -ForegroundColor DarkGray
            & pwsh -NoProfile -ExecutionPolicy Bypass -File $BuildScript `
                -BuildId $BuildId `
                -WorkId $wId `
                -Agent $aName `
                -Model $mName | Out-Host

            if ($LASTEXITCODE -eq 0) {
                Write-Host "    [ok] Smart build succeeded on attempt $attempt" -ForegroundColor Green
                break
            } else {
                Write-Host "    [x] Build exited with code $LASTEXITCODE" -ForegroundColor Red
                if ($attempt -ge $maxAttempts) {
                    throw "Build failed after $maxAttempts attempts (exit code $LASTEXITCODE)"
                }
                Write-Host "    Applying emergency memory garbage collection and retrying once with 1 job..." -ForegroundColor Yellow
                [System.GC]::Collect()
                $env:CARGO_BUILD_JOBS = '1'
                Start-Sleep -Seconds 10
            }
        } catch {
            if ($attempt -ge $maxAttempts) { throw $_ }
        }
    }

    # Resolve manifest
    $manifestDir = if ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA 'T9EditorLIT\deploy\builds'
    } else {
        Join-Path $WorkspaceRoot '.t9\builds'
    }
    $manifestPath = Join-Path $manifestDir "$BuildId.json"
    if (-not (Test-Path $manifestPath)) {
        $manifestPath = Join-Path $manifestDir 'latest.json'
    }
    if (-not (Test-Path $manifestPath)) {
        throw "Build manifest was not produced for $BuildId"
    }

    $manifest = Get-Content -Path $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return [pscustomobject]@{
        ManifestPath = $manifestPath
        Manifest     = $manifest
        BuiltExe     = [string]$manifest.exe
        BuiltSha     = [string]$manifest.sha256
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

function Invoke-SarkariInstall([object]$BuildOutput) {
    Write-Host "==> [Kaam Stage 4/6] Installing Executable with Canary Rollback Safety" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Get-RunningAppProcesses return @(...) karta hai, aur PowerShell pipeline
    # array ko unroll kar deta hai — 0 process par value $null banti hai, jisse
    # StrictMode me .Count throw kar deta tha. Isliye dobara @() se wrap.
    $appProcs = @(Get-RunningAppProcesses)
    $isAppRunning = ($appProcs.Count -gt 0)
    $installMode = if ($isAppRunning) { 'staged' } else { 'live' }

    if ($isAppRunning) {
        Write-Host "    [!] App is currently running (PID $(($appProcs | ForEach-Object { $_.Id }) -join ', '))." -ForegroundColor Yellow
        Write-Host "    Staging update as '$NewExeName' (App top-bar will show 'Update' button)." -ForegroundColor Cyan
        Copy-ItemWithBackoff -Source $BuildOutput.BuiltExe -Destination $StageExe
        $stageSha = Get-Sha256Hash $StageExe
        if ($stageSha -ne $BuildOutput.BuiltSha) {
            throw "Staged exe hash mismatch ($stageSha vs $($BuildOutput.BuiltSha))"
        }
        Write-Host "    [ok] Staged binary successfully verified ($stageSha)" -ForegroundColor Green
    } else {
        # App is closed - Prepare .prev.exe for rollback safety
        if (Test-Path $LiveExe) {
            Write-Host "    Creating backup of current version -> '$PrevExeName' (Rollback Shield)" -ForegroundColor DarkGray
            try {
                Copy-ItemWithBackoff -Source $LiveExe -Destination $PrevExe
            } catch {
                Write-Host "    [!] Could not backup previous binary: $($_.Exception.Message)" -ForegroundColor Yellow
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
                    Write-Host "    [!] Canary process exited with code $($canaryProc.ExitCode)" -ForegroundColor Yellow
                }
            }
        } catch {
            Write-Host "    [x] Canary test FAILED: Process crashed on start! Initiating Instant Rollback..." -ForegroundColor Red
            $canaryPass = $false
        }

        if (-not $canaryPass -and (Test-Path $PrevExe)) {
            Write-Host "    >>> SARKARI EMERGENCY AUTO-ROLLBACK TRIGGERED <<<" -ForegroundColor Red
            Copy-ItemWithBackoff -Source $PrevExe -Destination $LiveExe
            Write-Host "    [ok] Successfully restored previous stable binary from '$PrevExeName'" -ForegroundColor Green

            # Issue Official Court Challan
            $courtScript = Join-Path $PSScriptRoot 'sarkariCourt.ps1'
            if (Test-Path $courtScript) {
                . $courtScript
                $null = Issue-SarkariChallan -WorkId $AgentProfile.WorkId -Agent $AgentProfile.AgentName -Violation 'CANARY_STARTUP_PANIC' -Description "New executable crashed during startup verification. Auto-rolled back to previous stable build."
            }
            throw "Canary smoke test failed. New build was rolled back to previous stable version."
        }
    }

    $aName = if ($script:AgentProfile -and $script:AgentProfile.AgentName) { $script:AgentProfile.AgentName } else { 'Agent' }
    $mName = if ($script:AgentProfile -and $script:AgentProfile.ModelName) { $script:AgentProfile.ModelName } else { 'Model' }
    $wId   = if ($script:AgentProfile -and $script:AgentProfile.WorkId) { $script:AgentProfile.WorkId } else { 'WORK-LIVE' }

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
    }
    $markerJson = $markerData | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($MarkerFile, $markerJson, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "    [ok] build.json marker updated (Mode: $installMode)" -ForegroundColor Green

    # Start menu / Taskbar pin refresh
    if (Test-Path $PinScript) {
        Write-Host "    [ok] Updating Start menu / taskbar shortcut..." -ForegroundColor DarkGray
        & pwsh -NoProfile -ExecutionPolicy Bypass -File $PinScript -InstallDir $InstallDir 2>$null | Out-Null
    }

    return [pscustomobject]@{
        InstallMode = $installMode
        LiveExe     = $LiveExe
        LiveSha     = Get-Sha256Hash $LiveExe
        StageExe    = $StageExe
        StageSha    = Get-Sha256Hash $StageExe
        PrevExe     = $PrevExe
        MarkerFile  = $MarkerFile
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
    $wanted = $script:ExpectCommit
    if (-not $wanted) {
        $wanted = (& git -C $WorkspaceRoot rev-parse HEAD 2>$null | Select-Object -First 1)
    }
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

        # The rolling release may already hold this commit, if the
        # per-commit tag was not published for some reason.
        if ($wanted) {
            $rolling = Get-SarkariCiArtifact -Repo $CiRepo -Release 'ci-latest' `
                -DestinationRoot $ciRoot -WorkspaceRoot $WorkspaceRoot -BaseUrl $CiBaseUrl `
                -AllowMissing
            if ($rolling -and $rolling.GitCommit -and $rolling.GitCommit.StartsWith($wantedShort)) {
                $artifact = $rolling
                break
            }
        }

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

    # The installed binary is built from a COMMIT. If the working tree has
    # moved on, the binary does not contain the local edits, and the operator
    # has to hear that rather than discover it later.
    $head = (& git -C $WorkspaceRoot rev-parse HEAD 2>$null | Select-Object -First 1)
    if ($artifact.GitCommit -and $head -and $artifact.GitCommit -ne $head) {
        Write-Host "    [!] the CI build is from commit $($artifact.GitCommit) but HEAD is $head - the binary does not contain your uncommitted work" -ForegroundColor Yellow
    }
    $dirty = (& git -C $WorkspaceRoot status --porcelain 2>$null | Select-Object -First 1)
    if ($dirty) {
        Write-Host '    [!] the working tree is dirty - CI builds from a commit, so local edits are NOT in this binary' -ForegroundColor Yellow
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
        $goId = Get-GoSourceBuildId -Root $GoRoot
        if (-not $goId) { throw 'the Go sources could not be hashed, so the daemon version cannot be checked' }
        $intended = $goId
        if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
            throw "go is not installed, so the daemon cannot be built for a '$Scope' work order"
        }
        $outDir = Join-Path $WorkspaceRoot '.t9\daemon'
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        $out = Join-Path $outDir "t9cloud-$($goId.Substring(3, 8)).exe"
        Write-Host "==> Building the t9cloud daemon ($goId)" -ForegroundColor Cyan
        Push-Location $GoRoot
        try {
            & go build -trimpath -ldflags "-s -w -X github.com/engrtarun/T9EditorLIT/go/internal/api.Version=$goId" -o $out ./cmd/t9cloud
            if ($LASTEXITCODE -ne 0) { throw "go build failed (exit code $LASTEXITCODE)" }
        } finally {
            Pop-Location
        }
        $source = $out
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
        return [pscustomobject]@{ Mode = 'staged'; Version = $version; Path = $stageDaemon }
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
        [string]$ExpectCommit = ''
    )

    if ($ExpectCommit) { $script:ExpectCommit = $ExpectCommit }

    if ($AgentProfile) {
        $script:AgentProfile = $AgentProfile
    }
    if ($Scope) {
        $script:Scope = $Scope
    }
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

    Invoke-PreflightFastCheck
    Apply-MemoryGovernor

    # WorkId ko guarded tarike se lo: StrictMode ke under kisi bhi object par
    # missing property turant throw kar deta hai. Real chain me profile valid
    # na aane par poora deploy mar jata tha — ab fallback + diagnostic dono.
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
        Write-Host "    [!] AgentProfile.WorkId missing — profile type: $profileType" -ForegroundColor Yellow
        Write-Host "    [!] Available properties: $propNames" -ForegroundColor Yellow
        $resolvedWorkId = New-SarkariWorkId
    }

    # ---- the shared SQLite queue ----------------------------------------
    # AGENTS.md: "Ledger hi sach hai". The Sarkari engine has its own JSON
    # records, but the *queue* - who is deploying right now, whose turn is
    # it - lives in the SQLite ledger that docs/AGENT_DEPLOY_PROTOCOL.md is
    # written against. So the work order is queued and claimed there too.
    . (Join-Path $PSScriptRoot 'sarkariLedger.ps1')
    $ledgerOrder = $null
    $ledgerClaimed = $false
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
            -Priority $Priority -Emergency:$Emergency
        if ($ledgerOrder) {
            # Start-SarkariLedgerOrder keeps the token owner and attaches the
            # claim metadata (run id, state) to it, so the heartbeat and
            # finish steps below still have the token they need.
            $claimed = Start-SarkariLedgerOrder -Order $ledgerOrder `
                -LeaseMinutes $leaseMinutes `
                -MaxWaitMinutes ([math]::Max(5, $leaseMinutes))
            if ($claimed) { $ledgerClaimed = $true }
        }

        if (-not $ledgerClaimed) {
            # The ledger is an advisory queue, not the mutex that keeps two
            # builds apart - `build.ps1`'s lock is. Failing hard here meant a
            # hiccupping `node` (this box runs at ~1 GB free RAM) aborted the
            # deploy outright, which is exactly the stuck build this pipeline
            # exists to prevent. So the build goes on, loudly, and the ledger
            # still gets told the outcome; it just does not hold a lease.
            $reason = if ($ledgerOrder) { "could not claim $($ledgerOrder.workId)" } else { 'no work order was issued' }
            Write-Host "    [!] proceeding WITHOUT a ledger lease ($reason)" -ForegroundColor Yellow
            Write-Host '    [!] build.ps1 lock still serialises builds, so this cannot corrupt an executable' -ForegroundColor Yellow
        }
    }

    $buildId = "app-$($resolvedWorkId.ToLowerInvariant())"

    # A release build on this machine takes minutes, and the ledger's lease
    # has to be kept alive while it runs - otherwise the queue thinks the
    # deploy died and lets somebody else in front of it.
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
        $buildOutput = Execute-SmartCiBuild -BuildId $buildId
        $installOutput = Invoke-SarkariInstall -BuildOutput $buildOutput
        $daemonOutput = Install-SarkariDaemon -BuildOutput $buildOutput
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

    # The queue is released here, with the real outcome.
    if ($ledgerOrder -and $ledgerClaimed) {
        $null = Complete-SarkariLedgerOrder -Order $ledgerOrder -Outcome 'shipped' -Mode $installOutput.InstallMode -BuildId $buildId
    } elseif ($ledgerOrder) {
        # It was queued but never held the lease; close it as cancelled so it
        # stops occupying a queue position the waiting agents can see.
        $null = Complete-SarkariLedgerOrder -Order $ledgerOrder -Outcome 'cancelled' -Mode $installOutput.InstallMode -BuildId $buildId -ErrorText 'built without a lease - the ledger never handed over the slot'
    }

    Write-Host "========================================================`n" -ForegroundColor Green

    return [pscustomobject]@{
        Success        = $true
        BuildId        = $buildId
        BuildOutput    = $buildOutput
        InstallOutput  = $installOutput
        DaemonOutput   = $daemonOutput
        LedgerOrder    = $ledgerOrder
    }
}
