<#
.SYNOPSIS
    Sarkari Deploy Master Orchestrator (sarkariDeploy.ps1)

.DESCRIPTION
    Yeh master controller hai jo sabhi sarkari modules ko coordinate karta hai:
      [1] sarkariForm.ps1     -> Deep details collection (Identity, Task, Kyo, ETA, Breaking changes)
      [2] sarkariPermison.ps1 -> System & RAM Sanction, Lock inspection, Git state
      [3] sarkariAgent.ps1    -> Lease Sanction + Background 4-Minute Live Pulse Monitor
      [4] sarkariKaam.ps1     -> Fast Lane (TS + Cargo check), RAM Governor, Smart Build, Canary Smoke Test & Auto-Rollback
      [5] sarkariReport.ps1   -> Official Report Card & Permanent JSON Ledger Archive

    Switches:
      -Check     : Lightning Fast-Lane verification only (TypeScript, Svelte, Rust check in seconds)
      -Fast      : Autonomous fast deploy without interactive prompts
      -Doctor    : System health, exe, daemon & rollback inspection
      -Status    : Recent sarkari orders
      -Rollback  : Instant manual restore to .prev.exe
#>
[CmdletBinding()]
param(
    [string]$Agent = '',
    [string]$Model = '',
    [string]$Session = '',
    [string]$Task = '',
    [string]$Why = '',
    [string]$RootCause = '',
    [string]$TestingDone = '',
    [int]$EtaMinutes = 0,
    [string]$Scope = '',
    [string]$ModulesAffected = '',
    [switch]$IsBreakingChange = $false,
    [int]$Priority = 50,
    [switch]$Emergency = $false,
    [string]$FormFile = '',
    [switch]$Interactive = $false,
    [switch]$Fast = $false,
    [switch]$Check = $false,
    [switch]$Launch = $false,
    [switch]$Doctor = $false,
    [switch]$Status = $false,
    [switch]$Rollback = $false,
    [switch]$Court = $false,
    [switch]$Vakil = $false,
    [switch]$Database = $false,
    [switch]$Feedback = $false,
    [switch]$Force = $false,
    [string]$InstallDir = '',
    # -Ci installs the binary GitHub's runner built instead of compiling it
    # here. On this machine that build takes twelve minutes, holds the build
    # lock every other agent waits for, and can die in the linker when the RAM
    # runs out. The ledger, the lock, the canary and the marker are the same
    # either way; only the compiler moves.
    [switch]$Ci = $false,
    [string]$CiRelease = 'ci-latest',
    [string]$CiRepo = '',
    [string]$CiBaseUrl = '',
    [string]$ExpectCommit = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SarkariDir = $PSScriptRoot
$WorkspaceRoot = (Split-Path -Parent $SarkariDir)

# The live install folder is the ONE folder whose contents are the user's
# desktop app. A custom -InstallDir is a test target, never a desktop deploy:
# it must not repin the taskbar, and it must not be recorded as `shipped`.
$DefaultInstallDir = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'Programs\T9EditorLIT'
} else {
    Join-Path $WorkspaceRoot 'dist_installed'
}
if (-not $InstallDir) { $InstallDir = $DefaultInstallDir }

function Test-SarkariSamePath([string]$Left, [string]$Right) {
    try {
        $l = [IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
        $r = [IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
        return [string]::Equals($l, $r, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

$IsLiveInstall = Test-SarkariSamePath $InstallDir $DefaultInstallDir
$UsesCustomCiSource = [bool]$CiBaseUrl -or [bool]$CiRepo

$LiveExe = Join-Path $InstallDir 't9-editor-lit.exe'
$PrevExe = Join-Path $InstallDir 't9-editor-lit.prev.exe'
$StageExe = Join-Path $InstallDir 't9-editor-lit.new.exe'
$RecordsDir = Join-Path $SarkariDir 'records'

# One lock for every writer of the install folder. The normal pipeline takes
# it inside sarkariKaam; the manual rollback used to bypass it entirely, so a
# rollback could copy over an executable while a deploy was installing one.
$DeployLockDir = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'T9EditorLIT\deploy'
} else {
    Join-Path $WorkspaceRoot '.t9\deploy'
}
$DeployLockPath = Join-Path $DeployLockDir 'deploy.lock'

function Open-SarkariDeployLock([int]$TimeoutSeconds = 120) {
    if (-not (Test-Path $DeployLockDir)) {
        New-Item -ItemType Directory -Force -Path $DeployLockDir | Out-Null
    }
    $start = Get-Date
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
            Start-Sleep -Seconds 1
        }
    }
}

# ------------------------------------------------------------- 1. LIGHTNING FAST CHECK (-Check)
if ($Check) {
    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "  ⚡ SARKARI LIGHTNING FAST-LANE VERIFICATION (TS + RUST)" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
    . (Join-Path $SarkariDir 'sarkariKaam.ps1') -AgentProfile ([pscustomobject]@{ WorkId='CHECK-ONLY'; AgentName='FastCheck'; ModelName='Check'; Task='Fast check'; Why='Validation'; EtaMinutes=1; AllottedMinutes=5; StartTime=(Get-Date); StartTimeIso=(Get-Date).ToString('o') })
    try {
        Invoke-PreflightFastCheck
        Write-Host "`n  >>> ALL FAST-LANE CHECKS PASSED IN SECONDS! READY TO DEPLOY <<<" -ForegroundColor Green
        Write-Host "========================================================`n" -ForegroundColor Cyan
        exit 0
    } catch {
        Write-Host "`n  [x] FAST-LANE CHECK FAILED: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "========================================================`n" -ForegroundColor Red
        exit 1
    }
}

# ------------------------------------------------------------- 2. DOCTOR
if ($Doctor) {
    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "  🏛️  SARKARI SYSTEM & DEPLOYMENT DOCTOR" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host "  Install Directory: $InstallDir" -ForegroundColor Gray
    if (-not $IsLiveInstall) {
        Write-Host "  [*] This is a CUSTOM/TEST directory, not the live desktop install." -ForegroundColor Yellow
    }

    $doctorProblems = 0
    $liveHash = $null
    $markerPath = Join-Path $InstallDir 'build.json'
    $prevMarkerPath = Join-Path $InstallDir 'build.prev.json'

    if (Test-Path $LiveExe) {
        $liveHash = (Get-FileHash $LiveExe -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Host "  [ok] Live App Executable: PRESENT ($LiveExe)" -ForegroundColor Green
        Write-Host "       SHA-256: $liveHash" -ForegroundColor DarkGray
    } else {
        $doctorProblems++
        Write-Host "  [x] Live App Executable: NOT FOUND ($LiveExe)" -ForegroundColor Red
    }

    # The marker is half of the install proof. The other half is the exe on
    # disk. This used to print the hash and never compare the two, so a
    # hand-edited marker, a half-finished install or a silent rollback all
    # looked healthy.
    if (Test-Path $markerPath) {
        try {
            $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $markerBuild = [string]$marker.buildId
            $markerSha = [string]$marker.appSha256
            $markerMode = [string]$marker.mode
            $markerWork = [string]$marker.workId
            Write-Host "  [ok] build.json Marker: PRESENT (mode: $markerMode, buildId: $markerBuild)" -ForegroundColor Green
            if ($markerWork) { Write-Host "       Work Order: $markerWork" -ForegroundColor DarkGray }
            if (-not $markerBuild) {
                $doctorProblems++
                Write-Host "  [x] Marker has no buildId - it cannot prove which build is installed." -ForegroundColor Red
            }
            if (-not $markerSha) {
                $doctorProblems++
                Write-Host "  [x] Marker has no appSha256 - it cannot prove the executable." -ForegroundColor Red
            } elseif ($liveHash -and $markerSha -ne $liveHash) {
                $doctorProblems++
                Write-Host "  [x] Marker hash does not match the installed exe!" -ForegroundColor Red
                Write-Host "       marker: $markerSha" -ForegroundColor DarkGray
                Write-Host "       exe:    $liveHash" -ForegroundColor DarkGray
            } else {
                Write-Host "  [ok] Marker hash matches the installed executable." -ForegroundColor Green
            }
        } catch {
            $doctorProblems++
            Write-Host "  [x] build.json Marker is unreadable: $($_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        $doctorProblems++
        Write-Host "  [x] build.json Marker: MISSING ($markerPath)" -ForegroundColor Red
    }

    if (Test-Path $PrevExe) {
        Write-Host "  [ok] Rollback Shield (.prev.exe): READY for instant restore" -ForegroundColor Green
        if (Test-Path $prevMarkerPath) {
            try {
                $prevMarker = Get-Content -LiteralPath $prevMarkerPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $prevSha = [string]$prevMarker.appSha256
                $prevHash = (Get-FileHash $PrevExe -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($prevSha -and $prevSha -ne $prevHash) {
                    Write-Host "  [!] .prev.exe does not match build.prev.json - rollback would need -Force." -ForegroundColor Yellow
                } else {
                    Write-Host "       build.prev.json matches the rollback shield." -ForegroundColor DarkGray
                }
            } catch {
                Write-Host "  [!] build.prev.json is unreadable; rollback will need -Force." -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host "  [!] Rollback Shield (.prev.exe): None yet" -ForegroundColor Yellow
    }

    if (Test-Path $StageExe) {
        Write-Host "  [*] Staged Update (.new.exe): WAITING for user to click Update" -ForegroundColor Yellow
    } else {
        Write-Host "  [ok] Staged Update: No pending staged file" -ForegroundColor DarkGray
    }

    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:7878/healthz' -TimeoutSec 2 -ErrorAction Stop
        Write-Host "  [ok] t9cloud Daemon: RUNNING on localhost:7878 (Version: $($health.version))" -ForegroundColor Green
    } catch {
        Write-Host "  [!] t9cloud Daemon: OFFLINE or not responding on 127.0.0.1:7878" -ForegroundColor Yellow
    }
    Write-Host "========================================================`n" -ForegroundColor Cyan
    if ($doctorProblems -gt 0) { exit 1 }
    exit 0
}

# ------------------------------------------------------------- 3. ROLLBACK
if ($Rollback) {
    Write-Host "`n========================================================" -ForegroundColor Red
    Write-Host "  🏛️  SARKARI MANUAL ROLLBACK RESTORATION" -ForegroundColor Red
    Write-Host "========================================================" -ForegroundColor Red
    if (-not (Test-Path $PrevExe)) {
        Write-Host "  [x] Error: No previous backup found ($PrevExe)." -ForegroundColor Red
        exit 1
    }

    # -Fast means "do not ask questions during a deploy"; it is NOT consent to
    # replace the user's desktop app with an older binary. Only -Force (or an
    # explicit interactive yes) authorizes a rollback.
    $shouldRevert = [bool]$Force
    if (-not $shouldRevert) {
        if ($Fast) {
            Write-Host "  [x] -Fast does not authorize a rollback. Re-run with -Force after reviewing -Doctor." -ForegroundColor Red
            exit 1
        }
        $confirm = Read-Host "Are you sure you want to revert current app to previous stable build? [y/N]"
        $shouldRevert = ($confirm -match '^[yY]')
    }
    if (-not $shouldRevert) {
        Write-Host "  [!] Rollback cancelled." -ForegroundColor Yellow
        exit 0
    }

    $rollbackId = "SARKARI-ROLLBACK-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
    $rollbackAgent = if ($Agent) { $Agent } elseif ($env:T9_AGENT) { $env:T9_AGENT } else { 'manual-rollback' }
    $rollbackModel = if ($Model) { $Model } elseif ($env:T9_MODEL) { $env:T9_MODEL } else { 'manual-rollback' }
    $rollbackWhy = if ($Why) { $Why } else { 'Manual rollback requested by the user' }
    $rollbackForce = [bool]$Force
    $lock = $null
    try {
        $lock = Open-SarkariDeployLock
        . (Join-Path $SarkariDir 'sarkariKaam.ps1') -AgentProfile $null -InstallDir $InstallDir -Force:$rollbackForce
        $restored = Restore-SarkariPreviousBuild -InstallDir $InstallDir `
            -Agent $rollbackAgent -Model $rollbackModel -WorkId $rollbackId -Force:$rollbackForce
        Write-Host "  [ok] App restored from '$PrevExe' -> '$LiveExe'" -ForegroundColor Green
        Write-Host "       restored build: $($restored.BuildId) ($($restored.Sha))" -ForegroundColor Gray
    } catch {
        Write-Host "  [x] Rollback failed: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    } finally {
        if ($lock) { $lock.Close(); $lock.Dispose() }
    }

    # A rollback is a change to the user's desktop; it gets a record just like
    # a deploy, instead of silently copying an exe and leaving build.json
    # claiming the newer build is installed.
    $profile = [pscustomobject]@{
        WorkId          = $rollbackId
        AgentName       = $rollbackAgent
        ModelName       = $rollbackModel
        StartTime       = (Get-Date)
        StartTimeIso    = (Get-Date).ToUniversalTime().ToString('o')
        Why             = $rollbackWhy
        Task            = 'Manual rollback to previous build'
        EtaMinutes      = 1
        AllottedMinutes = 1
    }
    $kaam = [pscustomobject]@{
        BuildId      = $restored.BuildId
        BuildOutput  = $null
        InstallOutput = [pscustomobject]@{
            InstallMode = 'rollback'
            LiveExe     = $LiveExe
            LiveSha     = $restored.Sha
            StageExe    = $null
            StageSha    = $null
            PrevExe     = $PrevExe
            MarkerFile  = (Join-Path $InstallDir 'build.json')
        }
        DaemonOutput = $null
        LedgerOrder  = $null
    }
    . (Join-Path $SarkariDir 'sarkariReport.ps1') -AgentProfile $profile -KaamResult $kaam -Outcome 'ROLLED_BACK'
    exit 0
}

# ------------------------------------------------------------- 4. STATUS
if ($Status) {
    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "  🏛️  SARKARI RECENT DEPLOYMENT LEDGER ORDERS" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan

    # The SQLite ledger is the queue every agent waits in. Printing only the
    # Sarkari JSON records here made `deploy.ps1 -Status` look empty while
    # another agent was actively deploying.
    $ledgerScript = Join-Path $WorkspaceRoot 'Clipchamp_Bunny\tools\deploy-ledger.mjs'
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node -and (Test-Path -LiteralPath $ledgerScript)) {
        try {
            & $node.Source --no-warnings $ledgerScript status
        } catch {
            Write-Host "  [!] SQLite ledger status unavailable: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  [!] SQLite ledger status unavailable (node or deploy-ledger.mjs missing)" -ForegroundColor Yellow
    }

    if (Test-Path $RecordsDir) {
        $recent = @(Get-ChildItem -Path $RecordsDir -Filter 'SARKARI-*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 5)
        if ($recent.Length -eq 0) {
            Write-Host "  No Sarkari deploy records found yet." -ForegroundColor DarkGray
        } else {
            foreach ($file in $recent) {
                try {
                    $rec = Get-Content $file.FullName -Raw | ConvertFrom-Json
                    $col = if ($rec.outcome -eq 'SHIPPED') { 'Green' } else { 'Yellow' }
                    Write-Host "  [$($rec.outcome)] $($rec.workId)" -ForegroundColor $col
                    Write-Host "      Model: $($rec.modelName)  |  Time: $($rec.kabStartTime) IST" -ForegroundColor Gray
                    Write-Host "      Kyo:   $($rec.kyoReason)" -ForegroundColor White
                    Write-Host "      Duration: $($rec.asliTimeMinutes)m / Allotted: $($rec.sarkariSanctionMinutes)m`n" -ForegroundColor DarkGray
                } catch {}
            }
        }
    }
    exit 0
}

# ------------------------------------------------------------- 5. COURT, VAKIL, DB, FEEDBACK
if ($Court) {
    . (Join-Path $SarkariDir 'sarkariCourt.ps1') -Docket
    exit 0
}
if ($Vakil) {
    . (Join-Path $SarkariDir 'sarkariVakil.ps1') -Interactive
    exit 0
}
if ($Database) {
    . (Join-Path $SarkariDir 'sarkariDatabase.ps1') -All
    exit 0
}
if ($Feedback) {
    . (Join-Path $SarkariDir 'sarkariFeedback.ps1') -Interactive
    exit 0
}

# ------------------------------------------------------------- 6. MASTER END-TO-END FLOW
$pulseHandle = $null
$agentProfile = $null
$kaamResult = $null
$script:ActiveLedgerOrder = $null

try {
    # A custom artifact source or a custom install folder is a TEST path. It
    # cannot be allowed to replace the user's real desktop app, because a
    # hand-made manifest with matching hashes would otherwise be indistinguish-
    # able from CI's artifact. Tests must use -Force and a custom -InstallDir.
    if ($UsesCustomCiSource) {
        if (-not $Force) {
            throw "Refusing a custom -CiBaseUrl/-CiRepo without -Force. A custom artifact source is a test/mirror override; the normal deploy must use this repository's CI release."
        }
        if ($IsLiveInstall) {
            throw "Refusing to install a custom artifact source into the live desktop folder ($InstallDir). Point -InstallDir at a test folder; the live app may only be replaced by this repository's CI artifact."
        }
        Write-Host "  [!] TEST ARTIFACT SOURCE: $($CiBaseUrl)$($CiRepo) (not a desktop deploy)" -ForegroundColor Yellow
    } elseif (-not $IsLiveInstall -and -not $Force) {
        throw "Refusing a custom -InstallDir without -Force. A custom install folder is a test target and will never be recorded as 'shipped'."
    }

    # STEP 1: Deep Dossier & Form Collection
    # NOTE: dot-sourcing runs sarkariForm's param block in THIS scope. Without
    # forwarding the values it resets Agent/Task/Why/FormFile to '' and every
    # deploy is rejected as "too vague".
    . (Join-Path $SarkariDir 'sarkariForm.ps1') `
        -Agent $Agent -Model $Model -Session $Session -Task $Task -Why $Why `
        -RootCause $RootCause -TestingDone $TestingDone `
        -EtaMinutes $EtaMinutes -Scope $Scope -ModulesAffected $ModulesAffected `
        -IsBreakingChange:$IsBreakingChange -Priority $Priority `
        -Emergency:$Emergency -FormFile $FormFile -Interactive:$Interactive -Fast:$Fast
    
    $form = Get-SarkariApplicationForm `
        -Agent $Agent `
        -Model $Model `
        -Session $Session `
        -Task $Task `
        -Why $Why `
        -RootCause $RootCause `
        -TestingDone $TestingDone `
        -EtaMinutes $EtaMinutes `
        -Scope $Scope `
        -ModulesAffected $ModulesAffected `
        -IsBreakingChange:$IsBreakingChange `
        -Priority $Priority `
        -Emergency:$Emergency `
        -FormFile $FormFile `
        -Interactive:$Interactive `
        -Fast:$Fast

    # STEP 2: Sanction & System Permission
    . (Join-Path $SarkariDir 'sarkariPermison.ps1')
    $permission = Test-SarkariPermission
    if (-not $permission.Approved) {
        throw "Sarkari Sanction Rejected: $($permission.RejectionReasons -join '; ')"
    }

    # STEP 3: Agent Allocation & 4-Minute Pulse Monitor Start
    . (Join-Path $SarkariDir 'sarkariAgent.ps1')
    $agentProfile = Register-SarkariAgent `
        -Agent $form.Agent `
        -Model $form.Model `
        -TaskDesc $form.Task `
        -Reason $form.Why `
        -Cause $form.RootCause `
        -Testing $form.TestingDone `
        -Risk $form.RiskScore `
        -Eta $form.EtaMinutes

    Write-Host "==> Starting Sarkari 4-Minute Live Pulse Monitor..." -ForegroundColor Cyan
    $pulseHandle = Start-SarkariPulseMonitor -AgentProfile $agentProfile -ParentPid $PID
    if ($pulseHandle) {
        Write-Host "    [ok] 4-Minute progress pulse active (Reporting every 240 seconds)" -ForegroundColor Green
    }

    # STEP 4: Execution Pipeline (Fast-Check, Memory Governor, Smart Build + Canary Rollback)
    # Dot-source with values, or sarkariKaam's param block wipes $agentProfile
    # and $InstallDir in this scope before the call below.
    . (Join-Path $SarkariDir 'sarkariKaam.ps1') `
        -AgentProfile $agentProfile -Scope $form.Scope -InstallDir $InstallDir `
        -Priority $form.Priority -Emergency:$form.Emergency -Launch:$Launch `
        -Ci:$Ci -CiRelease $CiRelease -CiRepo $CiRepo -CiBaseUrl $CiBaseUrl `
        -ExpectCommit $ExpectCommit -Force:$Force -Session $form.Session
    $kaamResult = Execute-SarkariKaam -AgentProfile $agentProfile -Scope $form.Scope `
        -InstallDir $InstallDir -Priority $form.Priority -Emergency:$form.Emergency -Launch:$Launch `
        -Ci:$Ci -ExpectCommit $ExpectCommit -Force:$Force -Session $form.Session

    # Stop 4-minute monitor
    Stop-SarkariPulseMonitor -MonitorHandle $pulseHandle
    $pulseHandle = $null

    # STEP 5: Official Report Card & Bulletin
    # A test install is not a desktop deploy; docs and daemon-only orders did
    # not replace the app. The report says which one actually happened.
    $finalOutcome = if ($kaamResult.IsTestInstall) {
        'TEST'
    } else {
        switch ($kaamResult.InstallOutput.InstallMode) {
            'staged'   { 'STAGED' }
            'docs'     { 'DOCS' }
            'daemon'   { 'DAEMON' }
            'test'     { 'TEST' }
            'rollback' { 'ROLLED_BACK' }
            default    { 'SHIPPED' }
        }
    }
    . (Join-Path $SarkariDir 'sarkariReport.ps1') `
        -AgentProfile $agentProfile `
        -KaamResult $kaamResult `
        -Outcome $finalOutcome

    # Say what happened, in the exit code.
    #
    # Without this, PowerShell exits with the status of the LAST NATIVE
    # COMMAND that ran - and in this pipeline that is a `node` or a `git`
    # call whose status has nothing to do with the deploy. So a deploy that
    # installed the app, wrote the marker and closed the work order as
    # `shipped` still exited 1, and every wrapper that trusts the exit code
    # read a success as a failure. It was not a flaky thing: it was the
    # status of whichever helper happened to run last.
    #
    # A staged deploy is still a shipped deploy. The distinction is in the
    # marker and the ledger, not in the exit code.
    exit 0

} catch {
    $err = $_.Exception.Message
    Write-Host "`n[x] SARKARI PIPELINE FAILED: $err" -ForegroundColor Red

    if ($pulseHandle) {
        Stop-SarkariPulseMonitor -MonitorHandle $pulseHandle
        $pulseHandle = $null
    }

    # A failed deploy must close its queue slot too, or the next agent waits
    # for a lease that nobody is going to release. There are two handles:
    # the result (if Execute returned) and the active order Execute published
    # before it claimed the lease. The second one matters when Execute throws
    # after the claim but before it can return - a daemon-version failure or a
    # failed ledger finish used to leave the order active for its full lease.
    $orderToClose = $null
    if ($kaamResult -and $kaamResult.LedgerOrder) {
        $orderToClose = $kaamResult.LedgerOrder
    } elseif ($script:ActiveLedgerOrder) {
        $orderToClose = $script:ActiveLedgerOrder
    }
    if ($orderToClose) {
        try {
            . (Join-Path $SarkariDir 'sarkariLedger.ps1')
            $null = Complete-SarkariLedgerOrder -Order $orderToClose -Outcome 'failed' -ErrorText $err
            $script:ActiveLedgerOrder = $null
        } catch {
            Write-Host "  [!] could not close the failed ledger order: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    if ($agentProfile) {
        . (Join-Path $SarkariDir 'sarkariReport.ps1') `
            -AgentProfile $agentProfile `
            -KaamResult $kaamResult `
            -Outcome 'FAILED' `
            -ErrorText $err
    }
    exit 1
}
