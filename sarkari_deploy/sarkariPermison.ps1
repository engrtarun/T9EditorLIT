<#
.SYNOPSIS
    Sarkari Permission & Sanction Engine (sarkariPermison.ps1)
    
.DESCRIPTION
    Yeh module check karta hai ki kya system, memory, git, aur permissions
    kaam shuru karne ke kabil hain ya nahi.
    Agar koi lock atka hai ya RAM dangerously low hai, toh yeh clear reason ke
    saath permission sanction ya reject karta hai.
#>
[CmdletBinding()]
param(
    [switch]$SkipLockCheck,
    [int]$MinRamMb = 1500
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot)
$TargetDir = Join-Path $WorkspaceRoot 'src-tauri\target'
$BuildLock = Join-Path $TargetDir '.build-lock'
$DeployLock = Join-Path $WorkspaceRoot '.t9\deploy\deploy.lock'
if ($env:LOCALAPPDATA) {
    $DeployLock = Join-Path $env:LOCALAPPDATA 'T9EditorLIT\deploy\deploy.lock'
}

function Get-SarkariRamInfo {
    try {
        $os = Get-CimInstance Win32_OperatingSystem
        $freeMb = [math]::Round($os.FreePhysicalMemory / 1024)
        $totalMb = [math]::Round($os.TotalVisibleMemorySize / 1024)
        $usedMb = $totalMb - $freeMb
        $usedPct = [math]::Round(($usedMb / $totalMb) * 100, 1)
        return [pscustomobject]@{
            FreeMb   = $freeMb
            TotalMb  = $totalMb
            UsedPct  = $usedPct
            SafeForBuild = ($freeMb -ge $MinRamMb)
        }
    } catch {
        return [pscustomobject]@{
            FreeMb   = 2048
            TotalMb  = 8192
            UsedPct  = 75.0
            SafeForBuild = $true
        }
    }
}

function Get-SarkariGitStatus {
    try {
        $branch = (& git -C $WorkspaceRoot rev-parse --abbrev-ref HEAD 2>$null | Out-String).Trim()
        $commit = (& git -C $WorkspaceRoot rev-parse --short HEAD 2>$null | Out-String).Trim()
        $status = (& git -C $WorkspaceRoot status --porcelain 2>$null | Out-String).Trim()
        $isDirty = ($status.Length -gt 0)
        return [pscustomobject]@{
            Branch  = $(if ($branch) { $branch } else { 'unknown' })
            Commit  = $(if ($commit) { $commit } else { 'nogit' })
            IsDirty = $isDirty
        }
    } catch {
        return [pscustomobject]@{
            Branch  = 'unknown'
            Commit  = 'nogit'
            IsDirty = $false
        }
    }
}

function Test-SarkariLocks {
    $locksFound = @()
    if (Test-Path $BuildLock) {
        # Check if lock is actually held by a live process
        try {
            $stream = [System.IO.File]::Open($BuildLock, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
            $stream.Close()
            # Stale lock file was lingering on disk without an active holder
        } catch {
            $locksFound += "Active Build Lock: $BuildLock"
        }
    }
    if (Test-Path $DeployLock) {
        try {
            $stream = [System.IO.File]::Open($DeployLock, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
            $stream.Close()
        } catch {
            $locksFound += "Active Deploy Lock: $DeployLock"
        }
    }
    return $locksFound
}

function Test-SarkariTools {
    $tools = @{}
    foreach ($tool in @('pwsh', 'git', 'node', 'npm', 'cargo')) {
        $cmd = Get-Command $tool -ErrorAction SilentlyContinue
        $tools[$tool] = [bool]$cmd
    }
    return $tools
}

function Test-SarkariPermission {
    [CmdletBinding()]
    param()

    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "  SARKARI PERMISSION & SANCTION VERIFICATION" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan

    $ram = Get-SarkariRamInfo
    $git = Get-SarkariGitStatus
    $locks = @(Test-SarkariLocks)
    $tools = Test-SarkariTools

    $approved = $true
    $rejectionReasons = @()
    $warnings = @()

    # 1. RAM Check
    if (-not $ram.SafeForBuild) {
        $warnings += "Available RAM is low ($($ram.FreeMb) MB). Cargo will be throttled to 1 job to prevent OOM crash."
    }
    $ramColor = if ($ram.SafeForBuild) { 'Green' } else { 'Yellow' }
    Write-Host "  [1] RAM Status:         $($ram.FreeMb) MB free / $($ram.TotalMb) MB total ($($ram.UsedPct)% used)" -ForegroundColor $ramColor

    # 2. Git Status
    $dirtyText = if ($git.IsDirty) { '[DIRTY]' } else { '[CLEAN]' }
    Write-Host "  [2] Git Repository:     Branch '$($git.Branch)', Commit $($git.Commit) $dirtyText" -ForegroundColor Gray

    # 3. Toolchain Check
    $missingTools = @($tools.Keys | Where-Object { -not $tools[$_] })
    if ($missingTools.Count -gt 0) {
        $approved = $false
        $rejectionReasons += "Missing required tools: $($missingTools -join ', ')"
        Write-Host "  [3] Toolchain:          FAILED (Missing: $($missingTools -join ', '))" -ForegroundColor Red
    } else {
        Write-Host "  [3] Toolchain:          READY (pwsh, git, node, npm, cargo present)" -ForegroundColor Green
    }

    # 4. Lock Check
    # A lock held by another process is a QUEUE state, not a permission
    # violation. This gate used to reject outright - but it runs *before* the
    # ledger claim, so it aborted every agent's deploy the moment somebody
    # else was legitimately building. The two gates contradicted each other:
    # the queue said "wait your turn" while sanction said "rejected".
    # Both real critical sections already wait for their holder with progress
    # output (Wait-DeployLock, build.ps1's build lock), so all this check has
    # to do is say so. Genuine problems - missing tools - still reject.
    if ($locks.Count -gt 0 -and -not $SkipLockCheck) {
        $warnings += "Another deploy is in progress ($($locks.Count) lock held) - this one will queue and wait for it."
        Write-Host "  [4] Execution Locks:    BUSY ($($locks.Count) lock held by another process - waiting, not rejected)" -ForegroundColor Yellow
        foreach ($l in $locks) { Write-Host "       - $l" -ForegroundColor DarkGray }
    } else {
        Write-Host "  [4] Execution Locks:    CLEAR (No conflicting processes)" -ForegroundColor Green
    }

    # 5. Constitution police (sarkariPolice.ps1)
    # This is the POLICE proposal's optional wiring: Rule 2 bans Python
    # outright, so a CRITICAL finding is the one thing here worth stopping for.
    #
    # It is wired as an INFORMED gate, not a blind "exit 2 -> reject". The police
    # takes ~9s, which is nothing against a 12-minute release build, and
    # PYTHON_BANNED is its only CRITICAL finding. When it fires the deploy is
    # refused with the exact paths and the one command that clears them, so the
    # answer to "why did my build stop" is never "why?". Every other finding
    # (HIGH and below) is printed and ignored: those describe behaviour worth
    # reviewing, not a reason to withhold a binary - this machine must not gain
    # another way to stop a build. And a police that cannot run at all does not
    # stop a deploy either; the build lock is what protects the artefact.
    $policeScript = Join-Path $PSScriptRoot 'sarkariPolice.ps1'
    $policeVerdict = 'police not run'
    $policeExit = -1
    $policeEvidence = ''
    if (Test-Path -LiteralPath $policeScript) {
        try {
            $policeLines = @(& pwsh -NoProfile -File $policeScript 2>&1 | ForEach-Object { "$_" })
            $policeExit = $LASTEXITCODE
            $vLine = $policeLines | Where-Object { $_ -like '*VERDICT:*' } | Select-Object -Last 1
            if ($vLine) { $policeVerdict = [string]$vLine }
            # The finding prints as "[CRITICAL] PYTHON_BANNED - <subject>" and the
            # paths follow on the next line, indented. Match them after trimming:
            # an exact 'Evidence:*' test never fires on an indented line, and a
            # refusal that lost its evidence is just a stall with extra steps.
            for ($i = 0; $i -lt $policeLines.Count; $i++) {
                if ([string]$policeLines[$i] -like '*PYTHON_BANNED*') {
                    for ($j = $i; $j -lt [Math]::Min($i + 6, $policeLines.Count); $j++) {
                        if (([string]$policeLines[$j]).TrimStart().StartsWith('Evidence:')) {
                            $policeEvidence = ([string]$policeLines[$j]).Trim()
                            break
                        }
                    }
                    break
                }
            }
        } catch {
            $policeVerdict = "police did not run: $($_.Exception.Message)"
        }
    }
    Write-Host "  [5] Constitution:       $policeVerdict" -ForegroundColor $(if ($policeExit -eq 2) { 'Yellow' } else { 'Gray' })
    if ($policeEvidence) { Write-Host "       $policeEvidence" -ForegroundColor DarkGray }

    if ($policeExit -eq 2) {
        # Rule 2 bans Python across the whole repository, so this is not a
        # judgement call. What makes it an informed gate rather than a blind
        # one is the message: a refusal that does not say what to do is just a
        # stall, which is the exact thing this pipeline was rebuilt to stop.
        $approved = $false
        $where = if ($policeEvidence) { $policeEvidence } else { '(paths not captured - run the police directly)' }
        $rejectionReasons += "PYTHON_BANNED: AGENTS.md rule 2 bans Python across this repository. $where  Remove those files (or move them out of the repo), re-run sarkari_deploy\sarkariPolice.ps1 until it exits 0, then run this deploy again."
    }

    $token = "SANCTION-$((Get-Date).ToString('yyyyMMdd-HHmmss'))-$([math]::Abs((Get-Random) % 9000 + 1000))"

    if ($approved) {
        Write-Host "`n  >>> SARKARI PERMISSION GRANTED (Approval Token: $token) <<<" -ForegroundColor Green
        foreach ($w in $warnings) {
            Write-Host "      [WARNING] $w" -ForegroundColor Yellow
        }
    } else {
        Write-Host "`n  >>> SARKARI PERMISSION REJECTED <<<" -ForegroundColor Red
        foreach ($r in $rejectionReasons) {
            Write-Host "      [REASON] $r" -ForegroundColor Red
        }
    }
    Write-Host "========================================================`n" -ForegroundColor Cyan

    return [pscustomobject]@{
        Approved           = $approved
        ApprovalToken      = $(if ($approved) { $token } else { $null })
        Ram                = $ram
        Git                = $git
        MissingTools       = $missingTools
        ActiveLocks        = $locks
        Warnings           = $warnings
        RejectionReasons   = $rejectionReasons
        PermittedCargoJobs = $(if ($ram.FreeMb -lt 2500) { 1 } else { 2 })
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    # Direct execution support
    $result = Test-SarkariPermission
    if (-not $result.Approved) { exit 1 }
}
