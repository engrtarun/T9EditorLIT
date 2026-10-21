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

function Write-SarkariOwnerTimeline {
    <#
    .SYNOPSIS
        Tell the owner, in plain words, what is happening right now.
    .DESCRIPTION
        The bulletin below is a record: order id, hashes, timings. It answers
        "what did this deploy do", not "what is happening to me now". The
        question the owner actually has is the second one: another agent is
        building, when does MY work start, and when will it be on the
        desktop. Those three answers belong in the same place as everything
        else, and they are only knowable from the shared ledger - not from
        the deploy that is running.
    #>
    param(
        [string]$WorkId = '',
        [string]$TaskText = '',
        [int]$EtaMinutes = 0
    )

    $ledgerScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'Clipchamp_Bunny\tools\deploy-ledger.mjs'
    if (-not (Test-Path -LiteralPath $ledgerScript)) { return }

    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) { return }

    $state = $null
    try {
        $raw = & $node.Source --no-warnings $ledgerScript status --json 2>$null | Out-String
        $state = $raw | ConvertFrom-Json
    } catch {
        $state = $null
    }
    if (-not $state) { return }

    $now = [datetime]::UtcNow
    $ist = [System.TimeZoneInfo]::FindSystemTimeZoneById('India Standard Time')

    function Format-Ist($utc) {
        if (-not $utc) { return '-' }
        $t = if ($utc -is [datetime]) { $utc } else { [datetime]::Parse($utc).ToUniversalTime() }
        return ([System.TimeZoneInfo]::ConvertTimeFromUtc($t, $ist)).ToString('HH:mm:ss')
    }

    Write-Host "`n============================================================" -ForegroundColor DarkCyan
    Write-Host "  ABHI KYA HO RAHA HAI  (aapka kaam kab shuru, kab khatam)" -ForegroundColor DarkCyan
    Write-Host "============================================================" -ForegroundColor DarkCyan

    $active = $state.active
    if ($active) {
        $since = Format-Ist $active.startedAt
        $mins = [math]::Round(((Get-Date) - [datetime]::Parse($active.startedAt).ToLocalTime()).TotalMinutes, 0)
        Write-Host "  ABHI BUILD KAR RAHA HAI:" -ForegroundColor Yellow
        Write-Host ("     {0}/{1}" -f $active.agent, $active.model) -ForegroundColor Gray
        Write-Host ('     "{0}"' -f $active.task) -ForegroundColor DarkGray
        Write-Host ("     {0} se  ({1} min pehle)" -f $since, $mins) -ForegroundColor DarkGray
    } else {
        Write-Host "  ABHI KOI BUILD NAHI HO RAHA - lane khaali hai." -ForegroundColor Green
    }

    $mine = $null
    $ahead = @()
    foreach ($q in @($state.queue)) {
        # The ledger's own id is WO-..., while the report knows the work order
        # as SARKARI-.... The ledger's sessionId is what links them, so that
        # is what gets matched - the report must not claim a queue position
        # it cannot actually see.
        if ($q.id -eq $WorkId -or $q.sessionId -eq $WorkId) { $mine = $q } else { $ahead += $q }
    }

    if ($mine) {
        $pos = if ($null -ne $mine.position) { [int]$mine.position } else { ($ahead.Count + 1) }
        # Everything in front of this order still has to finish, and the one
        # in the lane has whatever it has left of its own estimate.
        $waitMin = 0
        if ($active) { $waitMin += [int]($active.remainingMinutes) }
        foreach ($a in $ahead) { $waitMin += [int]($a.remainingMinutes) }
        $startAt = $now.AddSeconds(60 * $waitMin)
        $doneAt = $startAt.AddSeconds(60 * [Math]::Max(1, $EtaMinutes))
        Write-Host "  AAPKA ORDER:" -ForegroundColor Cyan
        Write-Host ("     {0}" -f $mine.id) -ForegroundColor Gray
        Write-Host ('     "{0}"' -f $mine.task) -ForegroundColor DarkGray
        Write-Host ("     {0} par apply hua" -f (Format-Ist $mine.enqueuedAt)) -ForegroundColor DarkGray
        Write-Host ("     queue position {0}" -f $pos) -ForegroundColor DarkGray
        Write-Host ("     ~{0} me start hoga   ({1} min pehle wala kaam bacha hai)" -f (Format-Ist $startAt), $waitMin) -ForegroundColor Green
        Write-Host ("     ~{0} IST tak desktop par hoga   (aapka andaza {1} min)" -f (Format-Ist $doneAt), $EtaMinutes) -ForegroundColor Green
    } elseif ($active -and ($active.id -eq $WorkId -or $active.sessionId -eq $WorkId)) {
        Write-Host "  AAPKA ORDER:" -ForegroundColor Cyan
        Write-Host ("     {0}  - ABHI CHAL RAHA HAI" -f $active.id) -ForegroundColor Green
        Write-Host ('     "{0}"' -f $active.task) -ForegroundColor DarkGray
        Write-Host ("     {0} se" -f (Format-Ist $active.startedAt)) -ForegroundColor DarkGray
    } else {
        # The order is neither queued nor active, so it has already finished.
        # Saying "your order is being reported" would be true but useless;
        # what the owner wants to know is that it is DONE, and what came of it.
        $done = @($state.recent) | Where-Object { $_.id -eq $WorkId -or $_.sessionId -eq $WorkId } | Select-Object -First 1
        if ($done) {
            Write-Host "  AAPKA ORDER: KHATAM - $('{0}' -f $done.status.ToUpperInvariant())" -ForegroundColor Green
            Write-Host ("     {0}" -f $done.id) -ForegroundColor Gray
            Write-Host ('     "{0}"' -f $done.task) -ForegroundColor DarkGray
            Write-Host ("     {0} par apply hua, {1} par khatam" -f (Format-Ist $done.enqueuedAt), (Format-Ist $done.finishedAt)) -ForegroundColor DarkGray
            if ($done.finishedAt -and $done.enqueuedAt) {
                $took = [math]::Round(([datetime]::Parse($done.finishedAt) - [datetime]::Parse($done.enqueuedAt)).TotalMinutes, 1)
                Write-Host ("     poora laga: {0} min  (aapka andaza tha {1} min)" -f $took, $done.etaMinutes) -ForegroundColor DarkGray
            }
        } else {
            Write-Host "  AAPKA ORDER: report ban raha hai." -ForegroundColor Cyan
        }
    }
    Write-Host "============================================================" -ForegroundColor DarkCyan
}

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

Write-SarkariOwnerTimeline -WorkId $workId -TaskText $taskText -EtaMinutes $etaMinutes
Format-SarkariOfficialBulletin
$recordPath = Save-SarkariRecord
