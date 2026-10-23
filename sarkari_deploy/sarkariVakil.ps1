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
    [switch]$Interactive,
    # DRAFT mode: safai ka draft AI vakil persona se - koi plea FILE nahi
    # hoti; agent/user khud asli filing command chalate hain.
    [switch]$Draft
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SarkariDir = $PSScriptRoot
$ChallanDir = Join-Path $SarkariDir 'records\challans'
$PleaDir = Join-Path $SarkariDir 'records\pleas'
$TelemetryDir = Join-Path $SarkariDir 'records\telemetry'
New-Item -ItemType Directory -Force -Path $PleaDir | Out-Null

# AI engine (dot-source module) - sirf -Draft iska istemal karta hai.
. (Join-Path $PSScriptRoot 'sarkariBrain.ps1')

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
        # No invented fallback identity. The old default "Antigravity-Agent"
        # put a fictional name on a real court record; an empty answer now
        # stops the filing instead.
        $defAgent = [string]$env:T9_AGENT
        $prompt = if ($defAgent) { "Agent Name [$defAgent]" } else { 'Agent Name (required)' }
        $ans = Read-Host $prompt
        $script:AgentName = if ($ans) { $ans } elseif ($defAgent) { $defAgent } else { '' }
        if (-not $script:AgentName) { throw 'Agent name is required to file a plea; refusing to invent one.' }
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
    if (-not $script:AgentName) {
        throw 'Agent name is required to file a plea; refusing to record it under a made-up identity.'
    }

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

    # Filing a plea is not a ruling. The old code called the judge
    # immediately, so an agent's own grounds became a pardon. A human now
    # reviews the plea and runs the court with -ApprovePlea.
    if ($RequestHearing) {
        Write-Host "==> Plea filed; a human must approve the hearing." -ForegroundColor Cyan
        Write-Host "    Review the plea, then run:" -ForegroundColor Yellow
        Write-Host "    pwsh -File sarkari_deploy\sarkariCourt.ps1 -JudgePleaId $pleaId -ApprovePlea" -ForegroundColor Gray
    }

    return $pleaRecord
}

function Invoke-VakilDraftMode {
    # -Draft: safai ka DRAFT - AI vakil persona ke saath.
    # KUCH BHI FILE NAHI HOTA (na plea, na hearing, na telemetry copy).
    # Filing waisi hi pasina wali command se hogi jo neeche print hoti hai.
    #
    # Note: TelemetryDir pe New-Item main script nahi karta (filing se pehle
    # khali hai) - isliye yahan sab visits SilentlyContinue/bound-checked.
    $challan = $null
    if ($ChallanId) {
        $f = Join-Path $ChallanDir ("$ChallanId" + '.json')
        if (Test-Path -LiteralPath $f -PathType Leaf) {
            $challan = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json
        }
    } else {
        $candidates = @(
            Get-ChildItem -Path $ChallanDir -Filter 'CHALLAN-*.json' -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 3
        )
        foreach ($cand in $candidates) {
            try {
                $c = Get-Content -Path $cand.FullName -Raw | ConvertFrom-Json
                if ([string]$c.status -eq 'ACTIVE_PENALTY') { $challan = $c; break }
            } catch { }
        }
    }
    if (-not $challan) {
        Write-Host 'USAGE (vakil draft): -Draft ke saath target chaiye:' -ForegroundColor Yellow
        Write-Host '  pwsh -File sarkari_deploy\sarkariVakil.ps1 -Draft -ChallanId <challan-id>' -ForegroundColor Gray
        Write-Host '  (chhad do to sabse naya ACTIVE_PENALTY challan target hota hai - abhi koi nahi mila)' -ForegroundColor DarkGray
        exit 0
    }
    $challanIdUsed = [string]$challan.challanId
    $punishedAgent = [string]$challan.agent

    # Priors: challan wale agent ke doosre non-pardoned challans
    # (HONEST_MISTAKE_FIRST_OFFENSE sirf priors=0 par chalta hai).
    $priorChallans = @(
        Get-ChildItem -Path $ChallanDir -Filter 'CHALLAN-*.json' -ErrorAction SilentlyContinue |
            ForEach-Object {
                try { Get-Content -Path $_.FullName -Raw | ConvertFrom-Json } catch { $null }
            } |
            Where-Object {
                $_ -and
                [string]$_.challanId -ne $challanIdUsed -and
                [string]$_.agent -eq $punishedAgent -and
                [string]$_.status -ne 'PARDONED'
            }
    )

    # Telemetry proof ka sach: court sirf records\telemetry ke andar ki file
    # pakadta hai - bahar ka path reject. Agent ko iska sach batana zaroori.
    $telemetryFiles = @(
        Get-ChildItem -Path $TelemetryDir -Filter '*.json' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 5
    )

    $agentHint = if ($AgentName) { $AgentName } elseif ($env:T9_AGENT) { [string]$env:T9_AGENT } else { '(AGENT NAME REQUIRED - vakil khud identity mat banayega)' }

    Write-Host ''
    Write-Host '========================================================' -ForegroundColor Cyan
    Write-Host '  SARKARI VAKIL - SAFAI DRAFT (koi plea file NAHI hui)' -ForegroundColor Cyan
    Write-Host '========================================================' -ForegroundColor Cyan
    Write-Host ("  Challan:     {0}  ({1} pts, {2})" -f $challanIdUsed, $challan.points, $challan.violation) -ForegroundColor Yellow
    Write-Host ("  Agent:       {0}" -f $agentHint) -ForegroundColor White
    Write-Host ("  Priors:      {0} non-pardoned" -f $priorChallans.Count) -ForegroundColor DarkGray
    Write-Host ("  Telemetry:   {0} file(s) records\telemetry me" -f $telemetryFiles.Count) -ForegroundColor DarkGray

    $ctx = [ordered]@{
        challan        = [ordered]@{
            challanId   = $challanIdUsed
            agent       = $punishedAgent
            workId      = [string]$challan.workId
            violation   = [string]$challan.violation
            points      = [int]$challan.points
            status      = [string]$challan.status
            description = [string]$challan.description
        }
        priors         = @($priorChallans | Select-Object challanId, violation, points, status)
        priorCount     = $priorChallans.Count
        telemetryFiles = @($telemetryFiles | ForEach-Object { $_.Name })
        note           = 'AI sirf SAFAI DRAFT banata hai; plea file sarkariVakil.ps1 ke asli filing command se banti hai (user/agent chalayega).'
    }
    $r = Invoke-SarkariChat `
        -PersonaName 'vakil' `
        -UserText 'Is challan ke against Safai Nama ka DRAFT banao (grounds + safai statement + evidence checklist). Sach par dabe rahe - jhooth ki coaching nahi.' `
        -ContextText ($ctx | ConvertTo-Json -Depth 6 -Compress) `
        -Agent 'sarkari-vakil'

    Write-Host ''
    if ($r.Ok) {
        Write-Host 'AI SAFAI DRAFT (vakil persona - advisory)' -ForegroundColor Magenta
        foreach ($line in ($r.Content -split "`r?`n")) {
            if ($line.Trim()) { Write-Host ("  " + $line) -ForegroundColor White }
        }
    } else {
        Write-Host ("AI vakil upasthit nahi: {0}" -f $r.Short) -ForegroundColor Yellow
        Write-Host 'Local fallback - khud bharo (ye rule kanoon ka hai):' -ForegroundColor DarkGray
        Write-Host '  Telemetry grounds (ANTIVIRUS/OOM) => records\telemetry me proof file HONI CHAHIYE, warna PARDONED nahi hota.' -ForegroundColor DarkGray
        Write-Host '  HONEST_MISTAKE_FIRST_OFFENSE => priors 0 hote tabhi REDUCED; priors >0 par reject.' -ForegroundColor DarkGray
    }

    Write-Host ''
    Write-Host 'Asli filing command (agent/user khud chalaye - consent kaam user ka):' -ForegroundColor Yellow
    Write-Host ('  pwsh -File sarkari_deploy\sarkariVakil.ps1 -ChallanId {0} -AgentName "{1}" -PleaGrounds <ground> -SafaiStatement "<apna sach>" -AttachTelemetry -RequestHearing' -f $challanIdUsed, $agentHint) -ForegroundColor Gray
    Write-Host '  (hearing user ki approval se hoti hai: sarkariCourt.ps1 -JudgePleaId <pleaId> -ApprovePlea)' -ForegroundColor DarkGray
    Write-Host ''
    exit 0
}

if ($MyInvocation.InvocationName -ne '.') {
    if ($Draft) {
        Invoke-VakilDraftMode
        exit 0
    }
    $null = Submit-SafaiNama
}
