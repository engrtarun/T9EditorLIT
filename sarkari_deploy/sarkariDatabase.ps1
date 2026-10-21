<#
.SYNOPSIS
    Sarkari Central Database & Audit Dashboard (sarkariDatabase.ps1)

.DESCRIPTION
    Yeh Sarkari Database Explorer hai jisse user aur agents poora transparent
    audit data ek jagah dekh aur samajh sakte hain:
      - Work Orders & Deployed Builds
      - Hardware Telemetry & Top 6 Memory Process History
      - Court Docket & Challans
      - Vakil Safai Nama & Judicial Verdicts
      - Feedback, Complaints & Reviews
      - Open Contributions awaiting User Approval
#>
[CmdletBinding()]
param(
    [switch]$Orders,
    [switch]$Challans,
    [switch]$Telemetry,
    [switch]$Feedback,
    [switch]$Contributions,
    [switch]$All
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SarkariDir = $PSScriptRoot
$WorkspaceRoot = (Split-Path -Parent $SarkariDir)
$RecordsDir = Join-Path $SarkariDir 'records'
$ChallanDir = Join-Path $RecordsDir 'challans'
$PleaDir = Join-Path $RecordsDir 'pleas'
$TelemetryDir = Join-Path $RecordsDir 'telemetry'
$FeedbackDir = Join-Path $RecordsDir 'feedback'
$ContribDir = Join-Path $WorkspaceRoot 'sarkari_open_contribute\proposals'

function Show-DashboardHeader {
    Write-Host "`n╔════════════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║              🏛️  SARKARI CENTRAL DATABASE & AUDIT DASHBOARD 🏛️                  ║" -ForegroundColor Cyan
    Write-Host "╠════════════════════════════════════════════════════════════════════════════════╣" -ForegroundColor Cyan
    Write-Host "║ 100% Transparent Governance: Orders, Hardware Telemetry, Court & Feedback       ║" -ForegroundColor DarkGray
    Write-Host "╚════════════════════════════════════════════════════════════════════════════════╝`n" -ForegroundColor Cyan
}

function Show-RecentOrders {
    Write-Host "=== [1] RECENT DEPLOYMENT ORDERS & BUILDS ===" -ForegroundColor Yellow
    if (Test-Path $RecordsDir) {
        $recent = @(Get-ChildItem -Path $RecordsDir -Filter 'SARKARI-*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 5)
        if ($recent.Count -eq 0) {
            Write-Host "  No deploy orders recorded yet.`n" -ForegroundColor DarkGray
        } else {
            foreach ($f in $recent) {
                try {
                    $r = Get-Content -Path $f.FullName -Raw | ConvertFrom-Json
                    $col = if ($r.outcome -eq 'SHIPPED') { 'Green' } elseif ($r.outcome -eq 'STAGED') { 'Yellow' } else { 'Red' }
                    Write-Host "  [$($r.outcome)] $($r.workId) -> $($r.agent) ($($r.modelName))" -ForegroundColor $col
                    Write-Host "      Kyo: $($r.kyoReason)" -ForegroundColor White
                    Write-Host "      Time: $($r.kabStartTime) IST  |  Duration: $($r.asliTimeMinutes)m / Allotted: $($r.sarkariSanctionMinutes)m`n" -ForegroundColor DarkGray
                } catch {}
            }
        }
    }
}

function Show-RecentTelemetry {
    Write-Host "=== [2] HARDWARE TELEMETRY & TOP PROCESS SNAPSHOTS ===" -ForegroundColor Yellow
    if (Test-Path $TelemetryDir) {
        $recent = @(Get-ChildItem -Path $TelemetryDir -Filter '*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 3)
        if ($recent.Count -eq 0) {
            Write-Host "  No telemetry snapshots yet.`n" -ForegroundColor DarkGray
        } else {
            foreach ($f in $recent) {
                try {
                    $t = Get-Content -Path $f.FullName -Raw | ConvertFrom-Json
                    Write-Host "  [Telemetry] $($t.WorkId) on $($t.Timestamp)" -ForegroundColor Cyan
                    Write-Host "      Battery: $($t.BatteryCharge)% ($($t.BatteryStatus))  |  Free RAM: $($t.FreeRamMb) MB / $($t.TotalRamMb) MB ($($t.RamUsedPercent)% used)" -ForegroundColor Gray
                    $top3 = @($t.Top6Processes | Select-Object -First 3)
                    $topStr = ($top3 | ForEach-Object { "$($_.Process): $($_.RamMb)MB" }) -join ' | '
                    Write-Host "      Top Processes: $topStr`n" -ForegroundColor DarkGray
                } catch {}
            }
        }
    }
}

function Show-RecentCourt {
    Write-Host "=== [3] SARKARI ADALAT (CHALLANS & HEARINGS) ===" -ForegroundColor Yellow
    if (Test-Path $ChallanDir) {
        $recent = @(Get-ChildItem -Path $ChallanDir -Filter 'CHALLAN-*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 5)
        if ($recent.Count -eq 0) {
            Write-Host "  Court Docket is clear. Zero violations on record! [Good Standing]`n" -ForegroundColor Green
        } else {
            foreach ($f in $recent) {
                try {
                    $c = Get-Content -Path $f.FullName -Raw | ConvertFrom-Json
                    $col = if ($c.status -eq 'PARDONED') { 'Green' } elseif ($c.status -eq 'REDUCED') { 'Yellow' } else { 'Red' }
                    Write-Host "  [$($c.status)] $($c.challanId) -> $($c.agent) ($($c.points) pts)" -ForegroundColor $col
                    Write-Host "      Violation: $($c.violation)" -ForegroundColor White
                    Write-Host "      Verdict:   $($c.courtVerdict)`n" -ForegroundColor DarkGray
                } catch {}
            }
        }
    }
}

function Show-RecentFeedback {
    Write-Host "=== [4] SUJHAAV, SHIKAYAT & SAMIKSHA FEEDBACK ===" -ForegroundColor Yellow
    if (Test-Path $FeedbackDir) {
        $recent = @(Get-ChildItem -Path $FeedbackDir -Filter 'FB-*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 5)
        if ($recent.Count -eq 0) {
            Write-Host "  No feedback recorded yet.`n" -ForegroundColor DarkGray
        } else {
            foreach ($f in $recent) {
                try {
                    $fb = Get-Content -Path $f.FullName -Raw | ConvertFrom-Json
                    $col = if ($fb.type -eq 'SUJHAAV') { 'Cyan' } elseif ($fb.type -eq 'SHIKAYAT') { 'Red' } else { 'Yellow' }
                    Write-Host "  [$($fb.type)] $($fb.topic) by $($fb.author)" -ForegroundColor $col
                    Write-Host "      $($fb.message)`n" -ForegroundColor White
                } catch {}
            }
        }
    }
}

function Show-RecentContributions {
    Write-Host "=== [5] SARKARI OPEN-CONTRIBUTE (STAGED PROPOSALS) ===" -ForegroundColor Yellow
    if (Test-Path $ContribDir) {
        $recent = @(Get-ChildItem -Path $ContribDir -Filter '*.md' | Sort-Object LastWriteTime -Descending | Select-Object -First 5)
        if ($recent.Count -eq 0) {
            Write-Host "  No staged proposals waiting in sarkari_open_contribute/proposals.`n" -ForegroundColor DarkGray
        } else {
            foreach ($f in $recent) {
                Write-Host "  [PROPOSED] $($f.Name) (Awaiting User Veto / Approval)" -ForegroundColor Yellow
                Write-Host "      Path: $($f.FullName)`n" -ForegroundColor DarkGray
            }
        }
    }
}

# Main Execution
Show-DashboardHeader

$anyFilter = $Orders -or $Challans -or $Telemetry -or $Feedback -or $Contributions
if (-not $anyFilter -or $All) {
    Show-RecentOrders
    Show-RecentTelemetry
    Show-RecentCourt
    Show-RecentFeedback
    Show-RecentContributions
} else {
    if ($Orders) { Show-RecentOrders }
    if ($Telemetry) { Show-RecentTelemetry }
    if ($Challans) { Show-RecentCourt }
    if ($Feedback) { Show-RecentFeedback }
    if ($Contributions) { Show-RecentContributions }
}
