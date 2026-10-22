<#
.SYNOPSIS
    Sarkari Agent Registration & Deep 4-Minute Pulse Monitor (sarkariAgent.ps1)

.DESCRIPTION
    Yeh module agent ka registration karta hai, Model name, Root Cause, Testing Details,
    Risk Score record karta hai, aur background me har 4 minute par live progress
    pulse report user ko console par bhejta hai.
#>
[CmdletBinding()]
param(
    [string]$AgentName = '',
    [string]$ModelName = '',
    [string]$Task = '',
    [string]$Why = '',
    [string]$RootCause = '',
    [string]$TestingDone = '',
    [int]$RiskScore = 20,
    [int]$EtaMinutes = 0,
    [string]$WorkId = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# This file is dot-sourced by sarkariDeploy with no parameters, so the
# top-level values may legitimately be empty. Do not invent an identity here:
# Register-SarkariAgent validates the values the deploy actually supplies.
# The old "Antigravity-Agent / Gemini 3.8 Flash" fallback was a false
# attribution in the ledger and in the agent report.
if (-not $AgentName -and $env:T9_AGENT) { $AgentName = [string]$env:T9_AGENT }
if (-not $ModelName) {
    foreach ($envKey in @('T9_MODEL', 'OPENCODE_MODEL', 'OPENCODE_MODEL_ID')) {
        $val = [Environment]::GetEnvironmentVariable($envKey)
        if ($val) { $ModelName = $val; break }
    }
}

function New-SarkariWorkId {
    $datePart = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $randPart = -join ((1..4) | ForEach-Object { '{0:X}' -f (Get-Random -Minimum 0 -Maximum 16) })
    return "SARKARI-$datePart-$randPart"
}

function Get-SarkariLeaseMinutes([int]$EstimatedEta, [int]$Risk) {
    # Risk-Weighted Quota Allocation:
    # High Risk (>60) gets additional 20 min safety margin
    $riskBuffer = if ($Risk -ge 60) { 20 } else { 15 }
    $sanctioned = [Math]::Max(15, [Math]::Min(150, $EstimatedEta + $riskBuffer))
    return $sanctioned
}

function Register-SarkariAgent {
    [CmdletBinding()]
    param(
        [string]$Agent = $AgentName,
        [string]$Model = $ModelName,
        [string]$TaskDesc = $Task,
        [string]$Reason = $Why,
        [string]$Cause = $RootCause,
        [string]$Testing = $TestingDone,
        [int]$Risk = $RiskScore,
        [int]$Eta = $EtaMinutes,
        [string]$Id = $WorkId
    )

    # The deploy form already validates these, but Register-SarkariAgent is a
    # public function. Refusing here closes the direct-call path: no caller can
    # skip the form and still get a ledger identity or a time lease with blank
    # values. There is deliberately no default agent/model/ETA.
    $Agent = ([string]$Agent).Trim()
    $Model = ([string]$Model).Trim()
    $TaskDesc = ([string]$TaskDesc).Trim()
    $Reason = ([string]$Reason).Trim()
    if (-not $Agent -or $Agent.Length -lt 2) {
        throw "a real Agent name is required (2+ characters). Set -Agent or T9_AGENT; no invented fallback is used."
    }
    if (-not $Model -or $Model.Length -lt 3) {
        throw "a real Model name is required (3+ characters). Set -Model or T9_MODEL; no invented fallback is used."
    }
    if (-not $TaskDesc -or $TaskDesc.Length -lt 8) {
        throw "a real Task is required (8+ characters); it is recorded in the ledger and the deploy report."
    }
    if (-not $Reason -or $Reason.Length -lt 15) {
        throw "a real Why is required (15+ characters); it is recorded in the ledger and the deploy report."
    }
    if ($Eta -lt 1 -or $Eta -gt 480) {
        throw "a real ETA is required (1..480 minutes). A default ETA is not honest; pass -EtaMinutes explicitly."
    }

    if (-not $Id) { $Id = New-SarkariWorkId }
    $sanctionedLease = Get-SarkariLeaseMinutes -EstimatedEta $Eta -Risk $Risk
    $startTime = Get-Date

    Write-Host "`n--------------------------------------------------------" -ForegroundColor Yellow
    Write-Host "  🏛️  SARKARI AGENT ALLOCATION & TIME LEASE SANCTION" -ForegroundColor Yellow
    Write-Host "--------------------------------------------------------" -ForegroundColor Yellow
    Write-Host "  Work Order ID:           $Id" -ForegroundColor Cyan
    Write-Host "  Sarkari Agent:           $Agent" -ForegroundColor Gray
    Write-Host "  Model Name:              $Model" -ForegroundColor Magenta
    Write-Host "  Kab (Start Time):        $($startTime.ToString('yyyy-MM-dd HH:mm:ss')) IST" -ForegroundColor Gray
    Write-Host "  Kyo (Reason):            $Reason" -ForegroundColor White
    if ($Cause) {
        Write-Host "  Root Cause Resolved:     $Cause" -ForegroundColor DarkGray
    }
    if ($Testing) {
        Write-Host "  Testing Evidence:        $Testing" -ForegroundColor DarkGray
    }
    $riskColor = if ($Risk -gt 60) { 'Red' } else { 'Green' }
    Write-Host "  Sarkari Risk Score:      $Risk / 100" -ForegroundColor $riskColor
    Write-Host "  Andaza Time (ETA):       $Eta Minute(s) (Agent dwara bataya gaya)" -ForegroundColor Gray
    Write-Host "  Sarkari Sanction Time:   $sanctionedLease Minute(s) (Allotted Lease)" -ForegroundColor Green
    Write-Host "--------------------------------------------------------`n" -ForegroundColor Yellow

    return [pscustomobject]@{
        WorkId           = $Id
        AgentName        = $Agent
        ModelName        = $Model
        Task             = $TaskDesc
        Why              = $Reason
        RootCause        = $Cause
        TestingDone      = $Testing
        RiskScore        = $Risk
        EtaMinutes       = $Eta
        AllottedMinutes  = $sanctionedLease
        StartTime        = $startTime
        StartTimeIso     = $startTime.ToUniversalTime().ToString('o')
    }
}

function Start-SarkariPulseMonitor {
    [CmdletBinding()]
    param(
        [pscustomobject]$AgentProfile,
        [int]$ParentPid = $PID
    )

    # 4-Minute Live Pulse daemon (240s ticker)
    $pulseScriptContent = @"
param([int]`$PId, [string]`$WId, [string]`$MName, [string]`$StartIso, [int]`$EtaM, [int]`$AllotM, [string]`$TDesc, [string]`$TWhy, [int]`$RiskS)
`$elapsedMinutes = 0
while (`$true) {
    Start-Sleep -Seconds 240 # Har 4 minute me live pulse report (240 seconds)
    
    # Check if parent is still alive
    if (-not (Get-Process -Id `$PId -ErrorAction SilentlyContinue)) { break }
    
    `$elapsedMinutes += 4
    `$remaining = `$AllotM - `$elapsedMinutes
    `$freeMb = 0
    try {
        `$freeMb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
    } catch {}

    Write-Host "`n"
    Write-Host "╔════════════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Magenta
    Write-Host "║              ★ SARKARI LIVE PROGRESS REPORT (HAR 4 MIN UPDATE) ★               ║" -ForegroundColor Cyan
    Write-Host "╠════════════════════════════════════════════════════════════════════════════════╣" -ForegroundColor Magenta
    Write-Host ("║  [1] ORDER ID:        {0,-62} ║" -f `$WId) -ForegroundColor Gray
    Write-Host ("║  [2] MODEL NAME:      {0,-62} ║" -f `$MName) -ForegroundColor Yellow
    Write-Host ("║  [3] KAB SHURU HUA:   {0,-62} ║" -f (`$StartIso + " IST")) -ForegroundColor Gray
    Write-Host ("║  [4] KYO (REASON):    {0,-62} ║" -f `$TWhy.Substring(0, [Math]::Min(62, `$TWhy.Length))) -ForegroundColor White
    Write-Host ("║  [5] ANDAZA TIME:     {0,-62} ║" -f ("`$EtaM Minutes (Agent estimate)")) -ForegroundColor Gray
    Write-Host ("║  [6] SARKARI LEASE:   {0,-62} ║" -f ("`$AllotM Minutes (Sanctioned)")) -ForegroundColor Green
    Write-Host ("║  [7] BEET CHUKA TIME: {0,-62} ║" -f ("`$elapsedMinutes Minutes elapsed")) -ForegroundColor Cyan
    `$remColor = if (`$remaining -gt 5) { 'Green' } else { 'Red' }
    `$rColor = if (`$RiskS -gt 60) { 'Red' } else { 'Green' }
    Write-Host ("║  [8] BACHA HUA TIME:  {0,-62} ║" -f ("`$remaining Minutes remaining")) -ForegroundColor `$remColor
    Write-Host ("║  [9] RISK SCORE:      {0,-62} ║" -f ("`$RiskS / 100")) -ForegroundColor `$rColor
    Write-Host ("║  [10] LIVE RAM HEALTH:{0,-62} ║" -f ("`$freeMb MB Free Physical RAM")) -ForegroundColor Gray
    Write-Host ("║  [11] STATUS:         {0,-62} ║" -f "Compilation & Validation in Progress...") -ForegroundColor Green
    Write-Host "╚════════════════════════════════════════════════════════════════════════════════╝" -ForegroundColor Magenta
    Write-Host "`n"
}
"@

    $tempScript = Join-Path $env:TEMP "sarkari_pulse_$($AgentProfile.WorkId).ps1"
    Set-Content -Path $tempScript -Value $pulseScriptContent -Encoding UTF8

    try {
        $pwshCmd = (Get-Command pwsh -ErrorAction SilentlyContinue)
        $exe = if ($pwshCmd) { $pwshCmd.Source } else { 'powershell.exe' }
        $args = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tempScript,
            $ParentPid,
            $AgentProfile.WorkId,
            $AgentProfile.ModelName,
            $AgentProfile.StartTime.ToString('yyyy-MM-dd HH:mm:ss'),
            $AgentProfile.EtaMinutes,
            $AgentProfile.AllottedMinutes,
            $AgentProfile.Task,
            $AgentProfile.Why,
            $AgentProfile.RiskScore
        )
        $proc = Start-Process -FilePath $exe -ArgumentList $args -WindowStyle Hidden -PassThru
        return [pscustomobject]@{
            Process    = $proc
            ScriptPath = $tempScript
        }
    } catch {
        Write-Host "    [!] Could not launch background 4-minute pulse daemon: $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

function Stop-SarkariPulseMonitor([object]$MonitorHandle) {
    if ($MonitorHandle -and $MonitorHandle.Process) {
        try {
            if (-not $MonitorHandle.Process.HasExited) {
                Stop-Process -Id $MonitorHandle.Process.Id -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
    if ($MonitorHandle -and $MonitorHandle.ScriptPath -and (Test-Path $MonitorHandle.ScriptPath)) {
        try { Remove-Item $MonitorHandle.ScriptPath -Force -ErrorAction SilentlyContinue } catch {}
    }
}
