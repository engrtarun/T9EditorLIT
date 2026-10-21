<#
.SYNOPSIS
    Sarkari Official Deployment Report & Bulletin Generator (sarkariReport.ps1)

.DESCRIPTION
    Yeh module user ke liye official, transparent Sarkari Report generate karta hai.
    Points covered:
      - Work Order ID
      - Model Name
      - Kab [Time] apply kiya
      - Kyo [Reason] apply kiya
      - Kitne time ka andaza lagne wala hai (ETA)
      - Kitne time ke liye sarkariAgent ne time sanction kiya (Lease Allotted)
      - Actual Execution Time
      - Status / Outcome (Shipped / Staged / Rolled Back)
      - Binary Hashes & Evidence Proof
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [AllowNull()]
    [pscustomobject]$AgentProfile = $null,
    [Parameter(Mandatory=$false)]
    [AllowNull()]
    [pscustomobject]$KaamResult = $null,
    [string]$Outcome = 'SHIPPED',
    [string]$ErrorText = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot)
$RecordsDir = Join-Path $PSScriptRoot 'records'
New-Item -ItemType Directory -Force -Path $RecordsDir | Out-Null

function Get-PropSafe($obj, [string]$prop, $default = '') {
    if ($null -eq $obj) { return $default }
    $p = $obj.PSObject.Properties[$prop]
    if ($null -ne $p -and $null -ne $p.Value) { return $p.Value }
    return $default
}

if (-not $AgentProfile) {
    $AgentProfile = [pscustomobject]@{
        WorkId          = "SARKARI-$((Get-Date).ToString('yyyyMMdd-HHmmss'))-UNKNOWN"
        AgentName       = 'Unknown-Agent'
        ModelName       = 'Unknown-Model'
        StartTime       = (Get-Date)
        StartTimeIso    = (Get-Date).ToUniversalTime().ToString('o')
        Why             = 'Direct or unprofiled execution'
        Task            = 'Sarkari task execution'
        EtaMinutes      = 0
        AllottedMinutes = 0
    }
}

$workId = [string](Get-PropSafe $AgentProfile 'WorkId' "SARKARI-$((Get-Date).ToString('yyyyMMdd-HHmmss'))")
$agentName = [string](Get-PropSafe $AgentProfile 'AgentName' (Get-PropSafe $AgentProfile 'Agent' 'Agent'))
$modelName = [string](Get-PropSafe $AgentProfile 'ModelName' (Get-PropSafe $AgentProfile 'Model' 'Model'))
$startTime = (Get-PropSafe $AgentProfile 'StartTime' (Get-Date))
$startTimeIso = [string](Get-PropSafe $AgentProfile 'StartTimeIso' (Get-Date).ToUniversalTime().ToString('o'))
$whyText = [string](Get-PropSafe $AgentProfile 'Why' 'Continuous codebase enhancement and stabilization')
$taskText = [string](Get-PropSafe $AgentProfile 'Task' 'Sarkari task execution')
$etaMinutes = [int](Get-PropSafe $AgentProfile 'EtaMinutes' 0)
$allottedMinutes = [int](Get-PropSafe $AgentProfile 'AllottedMinutes' $etaMinutes)

$finishTime = Get-Date
$durationMinutes = [math]::Round(($finishTime - $startTime).TotalMinutes, 1)
$etaDelta = [math]::Round($durationMinutes - $etaMinutes, 1)
$deltaSign = if ($etaDelta -gt 0) { "+$etaDelta" } else { "$etaDelta" }

function Format-SarkariOfficialBulletin {
    [CmdletBinding()]
    param()

    $headerColor = if ($Outcome -eq 'SHIPPED') { 'Green' } elseif ($Outcome -eq 'STAGED') { 'Yellow' } else { 'Red' }

    Write-Host "`n"
    Write-Host "╔════════════════════════════════════════════════════════════════════════════════╗" -ForegroundColor $headerColor
    Write-Host "║                      🏛️  SARKARI DEPLOYMENT OFFICIAL REPORT  🏛️                  ║" -ForegroundColor $headerColor
    Write-Host "╠════════════════════════════════════════════════════════════════════════════════╣" -ForegroundColor $headerColor
    Write-Host ("║  [1] ORDER ID:         {0,-60} ║" -f $workId) -ForegroundColor Cyan
    Write-Host ("║  [2] MODEL NAME:       {0,-60} ║" -f $modelName) -ForegroundColor Yellow
    Write-Host ("║  [3] KAB (TIME):       {0,-60} ║" -f ($startTime.ToString('yyyy-MM-dd HH:mm:ss') + " IST")) -ForegroundColor Gray
    Write-Host ("║  [4] KYO (REASON):     {0,-60} ║" -f $whyText.Substring(0, [Math]::Min(60, $whyText.Length))) -ForegroundColor White
    if ($whyText.Length -gt 60) {
        Write-Host ("║                        {0,-60} ║" -f $whyText.Substring(60, [Math]::Min(60, $whyText.Length - 60))) -ForegroundColor White
    }
    Write-Host ("║  [5] ANDAZA TIME:      {0,-60} ║" -f "$etaMinutes Minutes (Agent dwara bataya gaya)") -ForegroundColor Gray
    Write-Host ("║  [6] SARKARI ALLOTTED: {0,-60} ║" -f "$allottedMinutes Minutes (Sarkari Agent dwara sanction)") -ForegroundColor Green
    Write-Host ("║  [7] ASLI TIME LAGA:   {0,-60} ║" -f "$durationMinutes Minutes ($deltaSign min vs ETA)") -ForegroundColor Cyan
    Write-Host ("║  [8] TASK DETAILS:     {0,-60} ║" -f $taskText.Substring(0, [Math]::Min(60, $taskText.Length))) -ForegroundColor Gray
    Write-Host ("║  [9] STATUS:           {0,-60} ║" -f $Outcome) -ForegroundColor $headerColor
    
    if ($KaamResult -and $KaamResult.InstallOutput) {
        $mode = $KaamResult.InstallOutput.InstallMode
        $sha = if ($mode -eq 'staged') { $KaamResult.InstallOutput.StageSha } else { $KaamResult.InstallOutput.LiveSha }
        $shaPrefix = if ($sha) { $sha.Substring(0, [Math]::Min(30, $sha.Length)) + "..." } else { "N/A" }
        Write-Host ("║  [10] MODE & HASH:     {0,-60} ║" -f "$mode - SHA: $shaPrefix") -ForegroundColor Gray
        $liveExeText = [string]$KaamResult.InstallOutput.LiveExe
        Write-Host ("║  [11] EXECUTABLE:      {0,-60} ║" -f $liveExeText.Substring(0, [Math]::Min(60, $liveExeText.Length))) -ForegroundColor DarkGray
    }
    
    if ($ErrorText) {
        Write-Host ("║  [x] ERROR DETAIL:     {0,-60} ║" -f $ErrorText.Substring(0, [Math]::Min(60, $ErrorText.Length))) -ForegroundColor Red
    }
    Write-Host "╚════════════════════════════════════════════════════════════════════════════════╝" -ForegroundColor $headerColor
    Write-Host "`n"
}

function Save-SarkariRecord {
    $record = [ordered]@{
        schema           = 1
        workId           = $workId
        agent            = $agentName
        modelName        = $modelName
        kabStartTime     = $startTime.ToString('yyyy-MM-dd HH:mm:ss')
        kabStartTimeIso  = $startTimeIso
        finishTime       = $finishTime.ToString('yyyy-MM-dd HH:mm:ss')
        finishTimeIso    = $finishTime.ToUniversalTime().ToString('o')
        kyoReason        = $whyText
        task             = $taskText
        andazaEtaMinutes = $etaMinutes
        sarkariSanctionMinutes = $allottedMinutes
        asliTimeMinutes  = $durationMinutes
        outcome          = $Outcome
        error            = $(if ($ErrorText) { $ErrorText } else { $null })
        buildId          = $(if ($KaamResult) { $KaamResult.BuildId } else { $null })
        installDetails   = $(if ($KaamResult) { $KaamResult.InstallOutput } else { $null })
    }

    $recordJson = $record | ConvertTo-Json -Depth 6
    $recordFile = Join-Path $RecordsDir "$workId.json"
    $latestRecord = Join-Path $RecordsDir "latest.json"
    $utf8 = New-Object System.Text.UTF8Encoding($false)

    [System.IO.File]::WriteAllText($recordFile, $recordJson, $utf8)
    [System.IO.File]::WriteAllText($latestRecord, $recordJson, $utf8)

    Write-Host "    [ok] Sarkari Record archived -> $recordFile" -ForegroundColor DarkGray
    return $recordFile
}

Format-SarkariOfficialBulletin
$recordPath = Save-SarkariRecord
