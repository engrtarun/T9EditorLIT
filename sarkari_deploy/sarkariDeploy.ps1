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
if (-not $InstallDir) {
    $InstallDir = if ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA 'Programs\T9EditorLIT'
    } else {
        Join-Path $WorkspaceRoot 'dist_installed'
    }
}

$LiveExe = Join-Path $InstallDir 't9-editor-lit.exe'
$PrevExe = Join-Path $InstallDir 't9-editor-lit.prev.exe'
$StageExe = Join-Path $InstallDir 't9-editor-lit.new.exe'
$RecordsDir = Join-Path $SarkariDir 'records'

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
    
    if (Test-Path $LiveExe) {
        $hash = (Get-FileHash $LiveExe -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Host "  [ok] Live App Executable: PRESENT ($LiveExe)" -ForegroundColor Green
        Write-Host "       SHA-256: $hash" -ForegroundColor DarkGray
    } else {
        Write-Host "  [!] Live App Executable: NOT FOUND ($LiveExe)" -ForegroundColor Red
    }

    if (Test-Path $PrevExe) {
        Write-Host "  [ok] Rollback Shield (.prev.exe): READY for instant restore" -ForegroundColor Green
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
    
    $shouldRevert = $Fast -or $Force
    if (-not $shouldRevert) {
        $confirm = Read-Host "Are you sure you want to revert current app to previous stable build? [y/N]"
        $shouldRevert = ($confirm -match '^[yY]')
    }
    if ($shouldRevert) {
        Copy-Item -Path $PrevExe -Destination $LiveExe -Force
        Write-Host "  [ok] App restored successfully from '$PrevExe' -> '$LiveExe'" -ForegroundColor Green
    } else {
        Write-Host "  [!] Rollback cancelled." -ForegroundColor Yellow
    }
    exit 0
}

# ------------------------------------------------------------- 4. STATUS
if ($Status) {
    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "  🏛️  SARKARI RECENT DEPLOYMENT LEDGER ORDERS" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
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

try {
    # STEP 1: Deep Dossier & Form Collection
    # NOTE: dot-sourcing runs sarkariForm's param block in THIS scope. Without
    # forwarding the values it resets Agent/Task/Why/FormFile to '' and every
    # deploy is rejected as "too vague".
    . (Join-Path $SarkariDir 'sarkariForm.ps1') `
        -Agent $Agent -Model $Model -Task $Task -Why $Why `
        -RootCause $RootCause -TestingDone $TestingDone `
        -EtaMinutes $EtaMinutes -Scope $Scope -ModulesAffected $ModulesAffected `
        -IsBreakingChange:$IsBreakingChange -Priority $Priority `
        -Emergency:$Emergency -FormFile $FormFile -Interactive:$Interactive
    
    $form = Get-SarkariApplicationForm `
        -Agent $Agent `
        -Model $Model `
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
        -Ci:$Ci -CiRelease $CiRelease -CiRepo $CiRepo -CiBaseUrl $CiBaseUrl -ExpectCommit $ExpectCommit
    $kaamResult = Execute-SarkariKaam -AgentProfile $agentProfile -Scope $form.Scope `
        -InstallDir $InstallDir -Priority $form.Priority -Emergency:$form.Emergency -Launch:$Launch `
        -Ci:$Ci -ExpectCommit $ExpectCommit

    # Stop 4-minute monitor
    Stop-SarkariPulseMonitor -MonitorHandle $pulseHandle
    $pulseHandle = $null

    # STEP 5: Official Report Card & Bulletin
    $finalOutcome = if ($kaamResult.InstallOutput.InstallMode -eq 'staged') { 'STAGED' } else { 'SHIPPED' }
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
    # for a lease that nobody is going to release.
    if ($kaamResult -and $kaamResult.LedgerOrder) {
        . (Join-Path $SarkariDir 'sarkariLedger.ps1')
        $null = Complete-SarkariLedgerOrder -Order $kaamResult.LedgerOrder -Outcome 'failed' -ErrorText $err
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
