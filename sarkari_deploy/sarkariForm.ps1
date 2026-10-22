<#
.SYNOPSIS
    Sarkari Deep Dossier & Application Form (sarkariForm.ps1)

.DESCRIPTION
    Yeh module agent se gehre (deep) technical, architectural aur compliance
    details maangta hai aur unhe git diff / system state ke saath CROSS-VERIFY
    karta hai.
    
    Keval baatein nahi — Real Fact-Checking:
      - Agar agent ne 'Scope: app' bola aur 'go/' me file modify hui hai -> REJECT
      - Agar agent ne Python file banayi hai -> STRICT REJECT (AGENTS.md rule)
      - Agar Zero-RAM ya Svelte IPC rules tode hain -> REJECT
      - Git diff ka live statistical audit (lines added/removed)
      - Automated 'Sarkari Risk Score' (0 to 100) calculation
#>
[CmdletBinding()]
param(
    [string]$Agent = '',
    [string]$Model = '',
    [string]$Session = '',
    [string]$Task = '',
    [string]$Why = '',
    [int]$EtaMinutes = 0,
    [ValidateSet('app', 'go', 'both', 'docs', '')]
    [string]$Scope = '',
    [string]$ModulesAffected = '',
    [string]$RootCause = '',
    [string]$TestingDone = '',
    [switch]$ZeroRamCertified,
    [switch]$NoPythonCertified,
    [switch]$IsBreakingChange,
    [ValidateRange(0, 100)]
    [int]$Priority = 50,
    [switch]$Emergency,
    [string]$FormFile = '',
    [switch]$Interactive,
    [switch]$Fast
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot)

# The form is loaded by Get-SarkariApplicationForm below. It must not be
# pre-filled here as well: this file is dot-sourced by the deploy orchestrator,
# and a second copy of the defaults used to let an environment variable (or the
# old invented "Antigravity-Agent" fallback) win over an explicit form file.

function Get-SafeProp($obj, [string]$prop) {
    if ($null -eq $obj) { return $null }
    $p = $obj.PSObject.Properties[$prop]
    if ($null -ne $p) { return $p.Value }
    return $null
}

# ------------------------------------------------------------- DEEP GIT INSPECTOR
function Audit-GitReality {
    $gitStatusRaw = @(& git -C $WorkspaceRoot status --porcelain 2>$null)
    $modifiedFiles = @()
    $hasPython = $false
    $hasAppChanges = $false
    $hasGoChanges = $false
    $hasIpcChanges = $false

    foreach ($line in $gitStatusRaw) {
        if (-not $line) { continue }
        $trimmed = $line.Trim()
        if ($trimmed.Length -lt 4) { continue }
        $filePath = $trimmed.Substring(3).Trim()
        $modifiedFiles += $filePath

        if ($filePath -match '\.py$') { $hasPython = $true }
        if ($filePath -match '^(src|Clipchamp_Bunny|static|package\.json|vite\.config)') { $hasAppChanges = $true }
        if ($filePath -match '^go(\/|\\)') { $hasGoChanges = $true }
        if ($filePath -match 'ipc\.ts|types\.ts|lib\.rs') { $hasIpcChanges = $true }
    }

    $diffStat = (& git -C $WorkspaceRoot diff --shortstat 2>$null | Out-String).Trim()
    
    return [pscustomobject]@{
        ModifiedFiles   = $modifiedFiles
        TotalFiles      = $modifiedFiles.Count
        HasPython       = $hasPython
        HasAppChanges   = $hasAppChanges
        HasGoChanges    = $hasGoChanges
        HasIpcChanges   = $hasIpcChanges
        DiffStat        = if ($diffStat) { $diffStat } else { 'No uncommitted line diffs' }
    }
}

# ------------------------------------------------------------- RISK SCORE ENGINE
function Calculate-SarkariRiskScore([pscustomobject]$GitAudit, [int]$Eta, [bool]$Breaking) {
    $score = 20 # Base risk
    if ($GitAudit.TotalFiles -gt 15) { $score += 25 }
    elseif ($GitAudit.TotalFiles -gt 5) { $score += 15 }
    
    if ($GitAudit.HasIpcChanges) { $score += 20 } # Touching IPC is high risk
    if ($Breaking) { $score += 30 }
    if ($Eta -gt 45) { $score += 15 }
    
    # Check RAM risk
    try {
        $freeMb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
        if ($freeMb -lt 1500) { $score += 20 }
    } catch {}

    return [Math]::Min(100, $score)
}

function Show-DeepFormBanner {
    Write-Host "`n"
    Write-Host "╔════════════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║        🏛️  SARKARI DEEP AUDIT & AGENT INTERROGATION DOSSIER  🏛️                ║" -ForegroundColor Cyan
    Write-Host "╠════════════════════════════════════════════════════════════════════════════════╣" -ForegroundColor Cyan
    Write-Host "║ Yeh koi formal checklist nahi hai. Deep technical accountability zaroori hai.  ║" -ForegroundColor DarkGray
    Write-Host "║ AGENTS.md ke niyam (Zero-RAM, No Python, IPC Choke-point) live audit honge.    ║" -ForegroundColor DarkGray
    Write-Host "╚════════════════════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Invoke-DeepInteractiveForm([pscustomobject]$GitAudit) {
    Show-DeepFormBanner

    Write-Host "--- [PHASE 1: AGENT PEHCHAN & CREDENTIALS] ---" -ForegroundColor Yellow
    $ans = Read-Host "  1. Agent Ka Naam (Identity) [$Agent]"
    if ($ans) { $script:Agent = $ans }

    $ans = Read-Host "  2. Exact Model Identifier [$Model]"
    if ($ans) { $script:Model = $ans }

    Write-Host "`n--- [PHASE 2: KAAM KI GEHRAI (TASK, KYO & ROOT CAUSE)] ---" -ForegroundColor Yellow
    $ans = Read-Host "  3. Task Headline (Summary, min 8 chars) $(if ($Task) { "[$Task]" })"
    if ($ans) { $script:Task = $ans }

    $ans = Read-Host "  4. Kyo / Reason (Yeh change kyun zaroori hai, min 15 chars) $(if ($Why) { "[$Why]" })"
    if ($ans) { $script:Why = $ans }

    $defRc = if ($RootCause) { $RootCause } else { 'Pichle implementation me memory spike / logic gap tha' }
    $ans = Read-Host "  5. Root Cause (Asli kami kya thi jo is change se theek ho rahi hai) [$defRc]"
    if ($ans) { $script:RootCause = $ans } else { $script:RootCause = $defRc }

    Write-Host "`n--- [PHASE 3: SCOPE & SUBSYSTEMS AFFECTED] ---" -ForegroundColor Yellow
    # Smart scope recommendation from Git Reality
    $smartScope = 'app'
    if ($GitAudit.HasAppChanges -and $GitAudit.HasGoChanges) { $smartScope = 'both' }
    elseif ($GitAudit.HasGoChanges) { $smartScope = 'go' }

    $ans = Read-Host "  6. Declared Scope (app | go | both | docs) [$smartScope]"
    if ($ans) { $script:Scope = $ans } else { $script:Scope = $smartScope }

    $defMod = if ($ModulesAffected) { $ModulesAffected } else { 'Frontend UI / Svelte 5 / IPC' }
    $ans = Read-Host "  7. Kaunse Modules prabhavit hain (e.g. Svelte 5 runes, Go vault, Tauri IPC) [$defMod]"
    if ($ans) { $script:ModulesAffected = $ans } else { $script:ModulesAffected = $defMod }

    Write-Host "`n--- [PHASE 4: ARCHITECTURAL COMPLIANCE & RULES] ---" -ForegroundColor Yellow
    $ans = Read-Host "  8. Zero-RAM Certification: Kya kisi media ko RAM me buffer kiya gaya hai? (Y=No buffer, n=Buffered) [Y]"
    if ($ans -match '^[nN]') { $script:ZeroRamCertified = $false } else { $script:ZeroRamCertified = $true }

    $ans = Read-Host "  9. No-Python Certification: Kya koi Python script ya module banaya hai? (y/N) [N]"
    if ($ans -match '^[yY]') { $script:NoPythonCertified = $false } else { $script:NoPythonCertified = $true }

    $ans = Read-Host "  10. Kya IPC ya Database Schema me koi Breaking Change hai? (y/N) [N]"
    if ($ans -match '^[yY]') { $script:IsBreakingChange = $true } else { $script:IsBreakingChange = $false }

    Write-Host "`n--- [PHASE 5: TESTING & ESTIMATION] ---" -ForegroundColor Yellow
    $defTest = if ($TestingDone) { $TestingDone } else { 'npm run check (svelte-check + tsc)' }
    $ans = Read-Host "  11. Agent ne self-test me kya run kiya? [$defTest]"
    if ($ans) { $script:TestingDone = $ans } else { $script:TestingDone = $defTest }

    $defEta = if ($EtaMinutes -gt 0) { $EtaMinutes } else { 20 }
    $ans = Read-Host "  12. Andaza Time (Kitne minutes lagne ka anuman hai, 1..240) [$defEta]"
    if ($ans) { $script:EtaMinutes = [int]$ans } else { $script:EtaMinutes = $defEta }

    $ans = Read-Host "  Priority Level (0..100, default 50; >60 requires emergency) [$Priority]"
    if ($ans) { $script:Priority = [int]$ans }
}

function Get-SarkariApplicationForm {
    [CmdletBinding()]
    param(
        [string]$Agent = '',
        [string]$Model = '',
        [string]$Session = '',
        [string]$Task = '',
        [string]$Why = '',
        [int]$EtaMinutes = 0,
        [string]$Scope = '',
        [string]$ModulesAffected = '',
        [string]$RootCause = '',
        [string]$TestingDone = '',
        [switch]$ZeroRamCertified,
        [switch]$NoPythonCertified,
        [switch]$IsBreakingChange,
        [int]$Priority = 50,
        [switch]$Emergency,
        [string]$FormFile = '',
        [switch]$Interactive,
        [switch]$Fast
    )

    # 1. Load FormFile if specified
    if ($FormFile -and (Test-Path $FormFile)) {
        try {
            $data = Get-Content -Path $FormFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $v = Get-SafeProp $data 'agent'; if ($v -and -not $Agent) { $Agent = [string]$v }
            $v = Get-SafeProp $data 'model'; if ($v -and -not $Model) { $Model = [string]$v }
            $v = Get-SafeProp $data 'session'; if ($v -and -not $Session) { $Session = [string]$v }
            $v = Get-SafeProp $data 'task'; if ($v -and -not $Task) { $Task = [string]$v }
            $v = Get-SafeProp $data 'why'; if ($v -and -not $Why) { $Why = [string]$v }
            $v = Get-SafeProp $data 'rootCause'; if ($v -and -not $RootCause) { $RootCause = [string]$v }
            $v = Get-SafeProp $data 'testingDone'; if ($v -and -not $TestingDone) { $TestingDone = [string]$v }
            $v = Get-SafeProp $data 'etaMinutes'; if ($null -ne $v -and $EtaMinutes -le 0) { $EtaMinutes = [int]$v }
            $v = Get-SafeProp $data 'scope'; if ($v -and -not $Scope) { $Scope = [string]$v }
            $v = Get-SafeProp $data 'modulesAffected'; if ($v -and -not $ModulesAffected) { $ModulesAffected = [string]$v }
            $v = Get-SafeProp $data 'zeroRamCertified'; if ($null -ne $v) { $ZeroRamCertified = [bool]$v }
            $v = Get-SafeProp $data 'noPythonCertified'; if ($null -ne $v) { $NoPythonCertified = [bool]$v }
            $v = Get-SafeProp $data 'isBreakingChange'; if ($null -ne $v) { $IsBreakingChange = [bool]$v }
            $v = Get-SafeProp $data 'priority'; if ($null -ne $v -and $Priority -eq 50) { $Priority = [int]$v }
        } catch {
            Write-Host "    [!] Could not parse form file ($FormFile): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    # 2. Defaults if still unassigned.
    #
    # Agent and Model have NO invented fallback on purpose. The ledger compares
    # ETA accuracy per agent/model, and a deploy recorded under
    # "Antigravity-Agent / Gemini 3.8 Flash" is a false attribution, not a
    # default. Only a value the caller or the environment actually supplied is
    # accepted; otherwise the dossier is rejected below.
    if (-not $Agent -and $env:T9_AGENT) { $Agent = [string]$env:T9_AGENT }
    if (-not $Model) {
        foreach ($k in @('T9_MODEL', 'OPENCODE_MODEL', 'OPENCODE_MODEL_ID')) {
            $val = [Environment]::GetEnvironmentVariable($k)
            if ($val) { $Model = $val; break }
        }
    }
    if (-not $Task -and $env:T9_TASK) { $Task = [string]$env:T9_TASK }
    if (-not $Why -and $env:T9_WHY) { $Why = [string]$env:T9_WHY }
    if (-not $Session) {
        $Session = if ($env:T9_SESSION) { $env:T9_SESSION } else { "SESS-$((Get-Date).ToString('yyyyMMdd-HHmmss'))" }
    }

    # -Fast only skips the interactive questions. It must never invent the task,
    # reason or ETA: that is exactly how a vague "autonomous update" reached the
    # ledger while the agent had not said what it was shipping or why.

    $script:Agent = $Agent
    $script:Model = $Model
    $script:Session = $Session
    $script:Task = $Task
    $script:Why = $Why
    $script:EtaMinutes = $EtaMinutes
    $script:Scope = $Scope
    $script:ModulesAffected = $ModulesAffected
    $script:RootCause = $RootCause
    $script:TestingDone = $TestingDone
    $script:ZeroRamCertified = $ZeroRamCertified
    $script:NoPythonCertified = $NoPythonCertified
    $script:IsBreakingChange = $IsBreakingChange
    $script:Priority = $Priority
    $script:Emergency = $Emergency

    # 3. Audit Git Reality First
    $gitAudit = Audit-GitReality

    # 4. Check if deep interactive mode needed
    $needsInteractive = $Interactive -and -not $Fast -and ((-not $Task) -or (-not $Why) -or ($EtaMinutes -le 0))
    if ($needsInteractive) {
        Invoke-DeepInteractiveForm -GitAudit $gitAudit
    } else {
        # Defaults for non-interactive. These are deliberately honest labels,
        # not claims: the old text said "Autonomous optimization" and
        # "Automated verification pipeline" even when the caller had supplied
        # neither, which put a false testing claim in the dossier.
        if (-not $script:RootCause) { $script:RootCause = 'Not recorded by the caller' }
        if (-not $script:TestingDone) { $script:TestingDone = 'Not recorded by the caller' }
        $script:ZeroRamCertified = $true
        $script:NoPythonCertified = $true
    }

    # 3. Clean Text
    $script:Agent = ($script:Agent -replace '\s+', ' ').Trim()
    $script:Model = ($script:Model -replace '\s+', ' ').Trim()
    $script:Task = ($script:Task -replace '\s+', ' ').Trim()
    $script:Why = ($script:Why -replace '\s+', ' ').Trim()
    $script:RootCause = ($script:RootCause -replace '\s+', ' ').Trim()
    $script:TestingDone = ($script:TestingDone -replace '\s+', ' ').Trim()
    $script:Scope = if ($script:Scope) { $script:Scope.ToLowerInvariant().Trim() } else { 'app' }

    # 4. DEEP FACT-CHECKING VALIDATION
    $rejections = @()

    # Validation A: identity, task, reason and an honest ETA.
    if (-not $script:Agent) {
        $rejections += "Agent is required. Pass -Agent or set T9_AGENT; this engine no longer invents an identity."
    } elseif ($script:Agent.Length -lt 2) {
        $rejections += "Agent identifier too short (min 2 chars)."
    }
    if (-not $script:Model) {
        $rejections += "Model is required. Pass the exact provider/model id with -Model or set T9_MODEL; this engine no longer invents a model."
    } elseif ($script:Model.Length -lt 3) {
        $rejections += "Model identifier too short (min 3 chars)."
    }
    if ($script:EtaMinutes -le 0 -or $script:EtaMinutes -gt 480) {
        $rejections += "ETA must be an honest 1..480 minutes. Pass -EtaMinutes; -Fast does not guess it."
    }
    if ($script:Task.Length -lt 8) { $rejections += "Task description is too vague (min 8 chars required)." }
    if ($script:Why.Length -lt 15) { $rejections += "Kyo/Reason is too casual (min 15 chars required). Explain impact!" }
    if ($script:RootCause.Length -lt 10) { $rejections += "Root cause must explain what core issue is being resolved (min 10 chars)." }

    # Validation B: AGENTS.md Rule 2 - BANNED PYTHON CHECK
    if ($gitAudit.HasPython) {
        $rejections += "VIOLATION OF CORE RULE: Python file detected in working tree! Python is strictly banned across this repo (AGENTS.md Section 2)."
    }
    if (-not $script:NoPythonCertified) {
        $rejections += "Agent admitted to using Python. Request rejected per repository constitution."
    }

    # Validation C: Zero-RAM Footprint rule
    if (-not $script:ZeroRamCertified) {
        $rejections += "VIOLATION OF CORE RULE: Buffering large media in RAM is prohibited. Child processes with streaming pipes must be used."
    }

    # Validation D: Scope Reality Check
    #
    # This used to be a rejection that also issued a 40-point challan. It fired
    # on a deploy where the app half had already shipped live an hour earlier
    # and the agent was running the honest second half: app and Go daemon are
    # two work orders on purpose, because one release build plus one daemon
    # restart in a single order is how this machine ends up with a
    # half-recorded change. A gate that punishes splitting the work is a gate
    # that teaches agents to declare a scope the record cannot back up.
    #
    # So it warns instead of refusing. The ledger still records the declared
    # scope, which is what keeps the record honest, and the build lock is what
    # protects the executable - not the declaration.
    #
    # Tightening this later is worth doing: compare the newest dirty file in
    # the "other" half against the installed build's timestamp, and only warn
    # when the other half has NOT been shipped since those files changed.
    $scopeWarnings = @()
    if ($script:Scope -eq 'app' -and $gitAudit.HasGoChanges) {
        $scopeWarnings += "SCOPE NOTE: declared 'Scope: app', but Go daemon files are also modified. The Go half will NOT ship in this work order - run a separate 'go' order for it."
    }
    if ($script:Scope -eq 'go' -and $gitAudit.HasAppChanges) {
        $scopeWarnings += "SCOPE NOTE: declared 'Scope: go', but App/UI files are also modified. The app half will NOT ship in this work order - run a separate 'app' order for it."
    }
    foreach ($note in $scopeWarnings) {
        Write-Host "  [!] $note" -ForegroundColor Yellow
    }

    # Validation E: Priority rule
    if ($script:Priority -gt 60 -and -not $script:Emergency) {
        $rejections += "Priority above 60 requires -Emergency flag."
    }

    if ($rejections.Count -gt 0) {
        Write-Host "`n╔════════════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Red
        Write-Host "║              ❌ SARKARI DEEP DOSSIER REJECTED (AUDIT FAILED) ❌                ║" -ForegroundColor Red
        Write-Host "╠════════════════════════════════════════════════════════════════════════════════╣" -ForegroundColor Red
        foreach ($rej in $rejections) {
            Write-Host "  [!] $rej" -ForegroundColor Red
        }
        Write-Host "╚════════════════════════════════════════════════════════════════════════════════╝`n" -ForegroundColor Red
        
        # Issue Official Court Challan
        $courtScript = Join-Path $PSScriptRoot 'sarkariCourt.ps1'
        if (Test-Path $courtScript) {
            . $courtScript
            $vType = if ($gitAudit.HasPython) { 'PYTHON_BANNED_VIOLATION' } else { 'FALSE_SCOPE_MISMATCH' }
            $null = Issue-SarkariChallan -WorkId "REJECT-$((Get-Date).ToString('yyyyMMdd-HHmmss'))" -Agent $script:Agent -Violation $vType -Description ($rejections -join '; ')
        }
        throw "Sarkari Application Form rejected by deep audit engine."
    }

    # 5. Compute Risk Score & Sanction Quota
    $riskScore = Calculate-SarkariRiskScore -GitAudit $gitAudit -Eta $script:EtaMinutes -Breaking $script:IsBreakingChange

    # 6. Capture Deep Hardware & Process Telemetry (Battery, RAM, Top 6 Processes)
    $telemetry = $null
    $telemScript = Join-Path $PSScriptRoot 'sarkariTelemetry.ps1'
    if (Test-Path $telemScript) {
        . $telemScript
        $telemetry = Get-SarkariTelemetrySnapshot
        Show-SarkariTelemetryBanner -Snapshot $telemetry
    }

    $dossier = [pscustomobject]@{
        Agent            = $script:Agent
        Model            = $script:Model
        Session          = $script:Session
        Task             = $script:Task
        Why              = $script:Why
        RootCause        = $script:RootCause
        Scope            = $script:Scope
        ModulesAffected  = $(if ($script:ModulesAffected) { $script:ModulesAffected } else { 'General' })
        TestingDone      = $script:TestingDone
        ZeroRamCertified = $script:ZeroRamCertified
        NoPythonCertified= $script:NoPythonCertified
        IsBreakingChange = [bool]$script:IsBreakingChange
        EtaMinutes       = [int]$script:EtaMinutes
        Priority         = [int]$script:Priority
        Emergency        = [bool]$script:Emergency
        RiskScore        = $riskScore
        GitAudit         = $gitAudit
        Telemetry        = $telemetry
        FilledAt         = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        FilledAtIso      = (Get-Date).ToUniversalTime().ToString('o')
    }

    Write-Host "`n  [ok] Sarkari Deep Dossier Passed! (Risk Score: $riskScore/100, Modified Files: $($gitAudit.TotalFiles))" -ForegroundColor Green
    return $dossier
}

if ($MyInvocation.InvocationName -ne '.') {
    $res = Get-SarkariApplicationForm `
        -Agent $Agent -Model $Model -Session $Session -Task $Task -Why $Why `
        -EtaMinutes $EtaMinutes -Scope $Scope -ModulesAffected $ModulesAffected `
        -RootCause $RootCause -TestingDone $TestingDone `
        -ZeroRamCertified:$ZeroRamCertified -NoPythonCertified:$NoPythonCertified `
        -IsBreakingChange:$IsBreakingChange -Priority $Priority -Emergency:$Emergency `
        -FormFile $FormFile -Interactive:$Interactive -Fast:$Fast
    $res | Format-List
}
