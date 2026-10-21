<#
.SYNOPSIS
    Sarkari Vakil / Defense Advocate Engine (sarkariVakil.ps1)

.DESCRIPTION
    Yeh module agent ka Sarkari Vakil (Defense Lawyer) hai jo agent ki taraf se
    'Safai Nama' (Formal Defense Plea) prepare karta hai aur Court me pesh karta hai.
    
    Valid Grounds for Defense:
      - ANTIVIRUS_DEFENDER_LOCK     : Windows Defender / MsMpEng held locked file
      - CRITICAL_OOM_SPIKE          : Background OS task exhausted remaining RAM
      - THIRD_PARTY_NETWORK_FAIL    : Network dropped during cargo crate download
      - HONEST_MISTAKE_FIRST_OFFENSE: Unintentional edge case, first violation
#>
[CmdletBinding()]
param(
    [string]$ChallanId = '',
    [string]$AgentName = '',
    [string]$SafaiStatement = '',
    [ValidateSet('ANTIVIRUS_DEFENDER_LOCK', 'CRITICAL_OOM_SPIKE', 'THIRD_PARTY_NETWORK_FAIL', 'HONEST_MISTAKE_FIRST_OFFENSE', '')]
    [string]$PleaGrounds = '',
    [switch]$AttachTelemetry,
    [switch]$RequestHearing,
    [switch]$Interactive
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SarkariDir = $PSScriptRoot
$ChallanDir = Join-Path $SarkariDir 'records\challans'
$PleaDir = Join-Path $SarkariDir 'records\pleas'
$TelemetryDir = Join-Path $SarkariDir 'records\telemetry'
New-Item -ItemType Directory -Force -Path $PleaDir | Out-Null

function Show-VakilBanner {
    Write-Host "`n"
    Write-Host "╔════════════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Yellow
    Write-Host "║              ⚖️  SARKARI VAKIL (DEFENSE ADVOCATE CHAMBER) ⚖️                   ║" -ForegroundColor Yellow
    Write-Host "╠════════════════════════════════════════════════════════════════════════════════╣" -ForegroundColor Yellow
    Write-Host "║ Har agent ko apni safai pesh karne ka poora adhikar hai.                        ║" -ForegroundColor DarkGray
    Write-Host "║ Sarkari Vakil aapke paksh me tarakshil Safai Nama prepare karega.             ║" -ForegroundColor DarkGray
    Write-Host "╚════════════════════════════════════════════════════════════════════════════════╝" -ForegroundColor Yellow
    Write-Host ""
}

function Invoke-VakilInteractive {
    Show-VakilBanner

    # Find latest active challan if not provided
    if (-not $script:ChallanId) {
        $recentChallan = Get-ChildItem -Path $ChallanDir -Filter 'CHALLAN-*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($recentChallan) {
            $defId = $recentChallan.BaseName
            $ans = Read-Host "Enter Challan ID to contest [$defId]"
            $script:ChallanId = if ($ans) { $ans } else { $defId }
        } else {
            $script:ChallanId = Read-Host "Enter Challan ID to contest"
        }
    }

    if (-not $script:AgentName) {
        $defAgent = if ($env:T9_AGENT) { $env:T9_AGENT } else { 'Antigravity-Agent' }
        $ans = Read-Host "Agent Name [$defAgent]"
        $script:AgentName = if ($ans) { $ans } else { $defAgent }
    }

    Write-Host "`nChoose Legal Grounds for Defense:" -ForegroundColor Cyan
    Write-Host "  [1] ANTIVIRUS_DEFENDER_LOCK      (MsMpEng / Defender locked exe)" -ForegroundColor Gray
    Write-Host "  [2] CRITICAL_OOM_SPIKE           (RAM dropped dangerously low)" -ForegroundColor Gray
    Write-Host "  [3] THIRD_PARTY_NETWORK_FAIL     (Network issue during package fetch)" -ForegroundColor Gray
    Write-Host "  [4] HONEST_MISTAKE_FIRST_OFFENSE (Unintentional slip, seeking pardon)" -ForegroundColor Gray
    $choice = Read-Host "Select Grounds (1-4) [1]"
    $script:PleaGrounds = switch ($choice) {
        '2' { 'CRITICAL_OOM_SPIKE' }
        '3' { 'THIRD_PARTY_NETWORK_FAIL' }
        '4' { 'HONEST_MISTAKE_FIRST_OFFENSE' }
        default { 'ANTIVIRUS_DEFENDER_LOCK' }
    }

    $ans = Read-Host "Apni Safai likhein (Detailed explanation of what went wrong, min 15 chars)"
    $script:SafaiStatement = $ans
    $script:AttachTelemetry = $true
    $script:RequestHearing = $true
}

function Submit-SafaiNama {
    [CmdletBinding()]
    param()

    if ($Interactive -or (-not $script:ChallanId) -or (-not $script:SafaiStatement)) {
        Invoke-VakilInteractive
    }

    if (-not $script:ChallanId) { throw "Challan ID is required to file a plea." }
    if ($script:SafaiStatement.Length -lt 15) { throw "Safai statement is too short (min 15 chars required). Explain properly!" }
    if (-not $script:PleaGrounds) { $script:PleaGrounds = 'HONEST_MISTAKE_FIRST_OFFENSE' }
    if (-not $script:AgentName) { $script:AgentName = 'Agent' }

    $pleaId = "PLEA-$((Get-Date).ToString('yyyyMMdd-HHmmss'))-$([math]::Abs((Get-Random) % 9000 + 1000))"

    # Check for telemetry evidence
    $telemetryFile = $null
    if ($AttachTelemetry) {
        $latestTelem = Get-ChildItem -Path $TelemetryDir -Filter '*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latestTelem) { $telemetryFile = $latestTelem.FullName }
    }

    $pleaRecord = [ordered]@{
        schema         = 1
        pleaId         = $pleaId
        challanId      = $script:ChallanId
        agent          = $script:AgentName
        submittedAt    = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        submittedAtIso = (Get-Date).ToUniversalTime().ToString('o')
        pleaGrounds    = $script:PleaGrounds
        safaiStatement = $script:SafaiStatement
        telemetryProof = $telemetryFile
        status         = 'SUBMITTED_TO_COURT'
    }

    $json = $pleaRecord | ConvertTo-Json -Depth 5
    $filePath = Join-Path $PleaDir "$pleaId.json"
    [System.IO.File]::WriteAllText($filePath, $json, (New-Object System.Text.UTF8Encoding($false)))

    Write-Host "`n╔════════════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "║              ⚖️  SAFAI NAMA FILED SUCCESSFULLY BY SARKARI VAKIL ⚖️             ║" -ForegroundColor Green
    Write-Host "╠════════════════════════════════════════════════════════════════════════════════╣" -ForegroundColor Green
    Write-Host ("║  Plea ID:       {0,-62} ║" -f $pleaId) -ForegroundColor Yellow
    Write-Host ("║  Contesting:    {0,-62} ║" -f $script:ChallanId) -ForegroundColor Gray
    Write-Host ("║  Advocate For:  {0,-62} ║" -f $script:AgentName) -ForegroundColor White
    Write-Host ("║  Legal Grounds: {0,-62} ║" -f $script:PleaGrounds) -ForegroundColor Cyan
    Write-Host ("║  Safai Summary: {0,-62} ║" -f $script:SafaiStatement.Substring(0, [Math]::Min(62, $script:SafaiStatement.Length))) -ForegroundColor DarkGray
    if ($telemetryFile) {
        Write-Host ("║  Evidence:      {0,-62} ║" -f "Telemetry Snapshot Attached") -ForegroundColor Green
    }
    Write-Host "╚════════════════════════════════════════════════════════════════════════════════╝`n" -ForegroundColor Green

    # Automatically trigger judicial review if requested
    if ($RequestHearing) {
        Write-Host "==> Presenting Safai Nama before Sarkari Judge immediately..." -ForegroundColor Cyan
        . (Join-Path $SarkariDir 'sarkariCourt.ps1') -JudgePleaId $pleaId
    }

    return $pleaRecord
}

if ($MyInvocation.InvocationName -ne '.') {
    $null = Submit-SafaiNama
}
