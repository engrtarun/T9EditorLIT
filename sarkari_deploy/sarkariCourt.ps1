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
    [string]$JudgePleaId = '',
    # A plea is not a self-service pardon. The script can prepare a record,
    # but a human must pass this switch after reading the evidence.
    [switch]$ApprovePlea
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

    # This used to be an automatic pardon path: filing a plea triggered the
    # judge, and the judge accepted the agent's own grounds. A human is the
    # final veto (see sarkariPolice.ps1), so the hearing now requires an
    # explicit approval switch.
    if (-not $ApprovePlea) {
        Write-Host "`n  [x] Judicial review needs explicit human approval." -ForegroundColor Red
        Write-Host "      Read the plea, then run:" -ForegroundColor Yellow
        Write-Host "      pwsh -File sarkari_deploy\sarkariCourt.ps1 -JudgePleaId $PleaId -ApprovePlea" -ForegroundColor Gray
        throw "plea $PleaId was not reviewed: -ApprovePlea was not supplied"
    }

    $plea = Get-Content -Path $pleaFile -Raw | ConvertFrom-Json
    if ($plea.status -ne 'SUBMITTED_TO_COURT') {
        throw "Plea $PleaId is already '$($plea.status)'; a plea can be judged once."
    }
    $challanFile = Join-Path $ChallanDir "$($plea.challanId).json"
    if (-not (Test-Path $challanFile)) {
        throw "Associated challan not found: $($plea.challanId)"
    }
    $challan = Get-Content -Path $challanFile -Raw | ConvertFrom-Json
    if ($challan.status -ne 'ACTIVE_PENALTY') {
        throw "Challan $($challan.challanId) is '$($challan.status)'; only an active penalty can be reviewed."
    }

    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "  ⚖️  SARKARI NYAYALAY: PLEA HEARING FOR $($plea.pleaId)" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host "  Agent:          $($plea.agent)" -ForegroundColor White
    Write-Host "  Challan ID:     $($plea.challanId)" -ForegroundColor Yellow
    Write-Host "  Original Fine:  $($challan.points) Points for $($challan.violation)" -ForegroundColor Red
    Write-Host "  Lawyer Defense: $($plea.safaiStatement)" -ForegroundColor Cyan
    Write-Host "  Grounds:        $($plea.pleaGrounds)" -ForegroundColor DarkGray

    # A prior non-pardoned challan means this is not a first offense, even if
    # the agent says it is. Count reduced/upheld rows; a pardon does not count.
    $priorChallans = @(
        Get-ChildItem -Path $ChallanDir -Filter 'CHALLAN-*.json' -ErrorAction SilentlyContinue |
            ForEach-Object {
                try { Get-Content -Path $_.FullName -Raw | ConvertFrom-Json } catch { $null }
            } |
            Where-Object {
                $_ -and $_.challanId -ne $challan.challanId -and
                $_.agent -eq $challan.agent -and $_.status -ne 'PARDONED'
            }
    )
    $hasTelemetry = [bool]($plea.telemetryProof -and (Test-Path -LiteralPath ([string]$plea.telemetryProof)))

    # Judicial Decision Algorithm
    $verdict = 'SENTENCE_UPHELD'
    $newPoints = [int]$challan.points
    $reason = ''

    if ($plea.pleaGrounds -eq 'ANTIVIRUS_DEFENDER_LOCK' -or $plea.pleaGrounds -eq 'CRITICAL_OOM_SPIKE') {
        if ($hasTelemetry) {
            $verdict = 'PARDONED'
            $newPoints = 0
            $reason = 'Court acknowledges external OS/Antivirus constraints; telemetry evidence is attached.'
        } else {
            $reason = 'External-cause defense rejected: no telemetry evidence was attached.'
        }
    } elseif ($plea.pleaGrounds -eq 'HONEST_MISTAKE_FIRST_OFFENSE') {
        if ($priorChallans.Count -eq 0) {
            $verdict = 'REDUCED'
            $newPoints = [int][math]::Round($challan.points / 2)
            $reason = "First offense with genuine Safai. Penalty halved from $($challan.points) to $newPoints pts."
        } else {
            $reason = "First-offense claim rejected: $($priorChallans.Count) prior non-pardoned challan(s) on record."
        }
    } else {
        $reason = 'Defense rejected. Inadequate evidence provided.'
    }

    # Update Challan record. SENTENCE_UPHELD must stay ACTIVE_PENALTY, or it
    # disappears from the docket and from the Police's active-challan check -
    # a plea that failed would otherwise erase the penalty.
    #
    # Add-Member -Force is deliberate: under StrictMode, assigning a property
    # that an older challan/plea record does not have is a terminating error.
    # The old code did exactly that, so the first real hearing crashed after
    # printing the verdict and left the record unchanged.
    $challan | Add-Member -NotePropertyName status -NotePropertyValue $(if ($verdict -eq 'PARDONED') { 'PARDONED' } elseif ($verdict -eq 'REDUCED') { 'REDUCED' } else { 'ACTIVE_PENALTY' }) -Force
    $challan | Add-Member -NotePropertyName points -NotePropertyValue $newPoints -Force
    $challan | Add-Member -NotePropertyName courtVerdict -NotePropertyValue $reason -Force
    $challan | Add-Member -NotePropertyName approvedBy -NotePropertyValue ([Environment]::UserName) -Force
    $challan | Add-Member -NotePropertyName approvedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force

    $updatedJson = $challan | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($challanFile, $updatedJson, (New-Object System.Text.UTF8Encoding($false)))

    $plea | Add-Member -NotePropertyName status -NotePropertyValue 'REVIEWED' -Force
    $plea | Add-Member -NotePropertyName reviewedBy -NotePropertyValue ([Environment]::UserName) -Force
    $plea | Add-Member -NotePropertyName reviewedAt -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
    $plea | Add-Member -NotePropertyName verdict -NotePropertyValue $verdict -Force
    [System.IO.File]::WriteAllText($pleaFile, ($plea | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))

    $vColor = if ($verdict -eq 'PARDONED') { 'Green' } elseif ($verdict -eq 'SENTENCE_UPHELD') { 'Red' } else { 'Yellow' }
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
