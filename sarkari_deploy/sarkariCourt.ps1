<#
.SYNOPSIS
    Sarkari Court & Judicial Adalat (sarkariCourt.ps1)

.DESCRIPTION
    Yeh Sarkari Nyayalay hai jo galti ya ghapla karne wale agents ko punish karta hai
    aur unpar official 'Challan' (Penalty) kaatta hai.
    
    Challan Categories:
      - PYTHON_BANNED_VIOLATION   : 100 Points (Constitution Violation - Disqualification)
      - CANARY_STARTUP_PANIC      : 35 Points  (App crashed on user desktop)
      - FALSE_SCOPE_MISMATCH      : 40 Points  (Claimed app, modified Go daemon)
      - LEASE_SQUATTING_HANG      : 25 Points  (Timed out or hogged lock)
      - BUILD_SYNTAX_ERROR        : 15 Points  (Pushed uncompiled broken code)

    Vakil (Advocate) dwara appeal karne par Judge 'Safai' sunta hai aur
    saza maaf (PARDON) ya kam (REDUCED) kar sakta hai!
#>
[CmdletBinding()]
param(
    [switch]$Docket,
    [string]$IssueChallanForWorkId = '',
    [string]$ViolationType = '',
    [string]$AgentName = '',
    [string]$Details = '',
    [string]$JudgePleaId = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SarkariDir = $PSScriptRoot
$ChallanDir = Join-Path $SarkariDir 'records\challans'
$PleaDir = Join-Path $SarkariDir 'records\pleas'
New-Item -ItemType Directory -Force -Path $ChallanDir | Out-Null
New-Item -ItemType Directory -Force -Path $PleaDir | Out-Null

function Issue-SarkariChallan {
    [CmdletBinding()]
    param(
        [string]$WorkId,
        [string]$Agent,
        [string]$Violation,
        [string]$Description,
        [int]$CustomPoints = 0
    )

    $points = switch ($Violation) {
        'PYTHON_BANNED_VIOLATION' { 100 }
        'FALSE_SCOPE_MISMATCH'    { 40 }
        'CANARY_STARTUP_PANIC'     { 35 }
        'LEASE_SQUATTING_HANG'     { 25 }
        'BUILD_SYNTAX_ERROR'       { 15 }
        default                    { if ($CustomPoints -gt 0) { $CustomPoints } else { 20 } }
    }

    $challanId = "CHALLAN-$((Get-Date).ToString('yyyyMMdd-HHmmss'))-$([math]::Abs((Get-Random) % 9000 + 1000))"
    $record = [ordered]@{
        schema         = 1
        challanId      = $challanId
        workId         = $WorkId
        agent          = $Agent
        issuedAt       = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        issuedAtIso    = (Get-Date).ToUniversalTime().ToString('o')
        violation      = $Violation
        points         = $points
        status         = 'ACTIVE_PENALTY' # ACTIVE_PENALTY, PARDONED, REDUCED, PAID
        description    = $Description
        courtVerdict   = 'Pending Review / Awaiting Vakil Safai'
    }

    $json = $record | ConvertTo-Json -Depth 5
    $filePath = Join-Path $ChallanDir "$challanId.json"
    [System.IO.File]::WriteAllText($filePath, $json, (New-Object System.Text.UTF8Encoding($false)))

    Write-Host "`n╔════════════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Red
    Write-Host "║                  ⚖️  SARKARI ADALAT: CHALLAN ISSUED! ⚖️                         ║" -ForegroundColor Red
    Write-Host "╠════════════════════════════════════════════════════════════════════════════════╣" -ForegroundColor Red
    Write-Host ("║  Challan ID:     {0,-60} ║" -f $challanId) -ForegroundColor Yellow
    Write-Host ("║  Agent:          {0,-60} ║" -f $Agent) -ForegroundColor White
    Write-Host ("║  Work Order ID:  {0,-60} ║" -f $WorkId) -ForegroundColor Gray
    Write-Host ("║  Violation:      {0,-60} ║" -f $Violation) -ForegroundColor Red
    Write-Host ("║  Penalty Points: {0,-60} ║" -f "$points Points") -ForegroundColor Red
    Write-Host ("║  Description:    {0,-60} ║" -f $Description.Substring(0, [Math]::Min(60, $Description.Length))) -ForegroundColor DarkGray
    Write-Host "╠════════════════════════════════════════════════════════════════════════════════╣" -ForegroundColor Red
    Write-Host "║ Agent chahe toh 'sarkariVakil.ps1' ke zariye Court me Safai pesh kar sakta hai.║" -ForegroundColor Yellow
    Write-Host "╚════════════════════════════════════════════════════════════════════════════════╝`n" -ForegroundColor Red

    return $record
}

function Show-CourtDocket {
    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "  ⚖️  SARKARI COURT DOCKET & ACTIVE CHALLANS" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
    
    $files = @(Get-ChildItem -Path $ChallanDir -Filter 'CHALLAN-*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 10)
    if ($files.Count -eq 0) {
        Write-Host "  No active challans on record. All agents are currently in good standing! [Clean Record]" -ForegroundColor Green
    } else {
        foreach ($f in $files) {
            try {
                $c = Get-Content -Path $f.FullName -Raw | ConvertFrom-Json
                $color = if ($c.status -eq 'PARDONED') { 'Green' } elseif ($c.status -eq 'REDUCED') { 'Yellow' } else { 'Red' }
                Write-Host "  [$($c.status)] $($c.challanId) -> $($c.agent)" -ForegroundColor $color
                Write-Host "      Violation: $($c.violation) ($($c.points) pts) | Order: $($c.workId)" -ForegroundColor Gray
                Write-Host "      Reason:    $($c.description)" -ForegroundColor White
                Write-Host "      Verdict:   $($c.courtVerdict)`n" -ForegroundColor DarkGray
            } catch {}
        }
    }
    Write-Host "========================================================`n" -ForegroundColor Cyan
}

function Invoke-JudgeReview([string]$PleaId) {
    $pleaFile = Join-Path $PleaDir "$PleaId.json"
    if (-not (Test-Path $pleaFile)) {
        throw "Plea file not found: $pleaFile"
    }

    $plea = Get-Content -Path $pleaFile -Raw | ConvertFrom-Json
    $challanFile = Join-Path $ChallanDir "$($plea.challanId).json"
    if (-not (Test-Path $challanFile)) {
        throw "Associated challan not found: $($plea.challanId)"
    }
    $challan = Get-Content -Path $challanFile -Raw | ConvertFrom-Json

    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "  ⚖️  SARKARI NYAYALAY: PLEA HEARING FOR $($plea.pleaId)" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host "  Agent:          $($plea.agent)" -ForegroundColor White
    Write-Host "  Challan ID:     $($plea.challanId)" -ForegroundColor Yellow
    Write-Host "  Original Fine:  $($challan.points) Points for $($challan.violation)" -ForegroundColor Red
    Write-Host "  Lawyer Defense: $($plea.safaiStatement)" -ForegroundColor Cyan
    Write-Host "  Grounds:        $($plea.pleaGrounds)" -ForegroundColor DarkGray

    # Judicial Decision Algorithm
    $verdict = 'REDUCED'
    $newPoints = [math]::Round($challan.points / 2)
    $reason = ''

    if ($plea.pleaGrounds -eq 'ANTIVIRUS_DEFENDER_LOCK' -or $plea.pleaGrounds -eq 'CRITICAL_OOM_SPIKE') {
        $verdict = 'PARDONED'
        $newPoints = 0
        $reason = "Court acknowledges external OS/Antivirus environment constraints beyond agent control."
    } elseif ($plea.pleaGrounds -eq 'HONEST_MISTAKE_FIRST_OFFENSE') {
        $verdict = 'REDUCED'
        $newPoints = [math]::Round($challan.points / 2)
        $reason = "First offense with genuine Safai. Penalty halved from $($challan.points) to $newPoints pts."
    } else {
        $verdict = 'SENTENCE_UPHELD'
        $newPoints = $challan.points
        $reason = "Defense rejected. Inadequate evidence provided."
    }

    # Update Challan record
    $challan.status = $verdict
    $challan.points = $newPoints
    $challan.courtVerdict = $reason

    $updatedJson = $challan | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($challanFile, $updatedJson, (New-Object System.Text.UTF8Encoding($false)))

    $vColor = if ($verdict -eq 'PARDONED') { 'Green' } else { 'Yellow' }
    Write-Host "`n  >>> SARKARI JUDGE VERDICT: $verdict <<<" -ForegroundColor $vColor
    Write-Host "      Judicial Rationale: $reason" -ForegroundColor White
    $pColor = if ($newPoints -eq 0) { 'Green' } else { 'Yellow' }
    Write-Host "      Updated Penalty:    $newPoints Points" -ForegroundColor $pColor
    Write-Host "========================================================`n" -ForegroundColor Cyan
}

if ($Docket) {
    Show-CourtDocket
    exit 0
}

if ($JudgePleaId) {
    Invoke-JudgeReview -PleaId $JudgePleaId
    exit 0
}

if ($IssueChallanForWorkId -and $ViolationType) {
    $null = Issue-SarkariChallan -WorkId $IssueChallanForWorkId -Agent $AgentName -Violation $ViolationType -Description $Details
    exit 0
}
