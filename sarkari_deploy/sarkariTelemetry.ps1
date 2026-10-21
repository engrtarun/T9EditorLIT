<#
.SYNOPSIS
    Sarkari Deep Hardware & Process Telemetry Engine (sarkariTelemetry.ps1)

.DESCRIPTION
    Yeh engine apply time par deep machine forensics capture karta hai:
      - Battery percentage, Charging/Discharging/AC status
      - Live RAM status (Free, Total, Used %)
      - TOP 6 Memory Consuming Processes (Name, PID, RAM MB)
      - Disk & CPU cores
    Isse pata chalta hai ki agar koi build slow hua ya crash hua, toh peeche
    kaunsa process RAM kha raha tha!
#>
[CmdletBinding()]
param(
    [string]$WorkId = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SarkariDir = $PSScriptRoot
$TelemetryDir = Join-Path $SarkariDir 'records\telemetry'
New-Item -ItemType Directory -Force -Path $TelemetryDir | Out-Null

function Get-SarkariBatteryStatus {
    try {
        $battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($battery) {
            $statusDesc = switch ($battery.BatteryStatus) {
                1 { 'Discharging (Battery)' }
                2 { 'Connected to AC (Charging / Full)' }
                3 { 'Fully Charged' }
                4 { 'Low Battery' }
                5 { 'Critical Battery' }
                default { 'On AC Power' }
            }
            return [pscustomobject]@{
                HasBattery      = $true
                EstimatedCharge = [int]$battery.EstimatedChargeRemaining
                StatusDescription = $statusDesc
            }
        }
    } catch {}

    return [pscustomobject]@{
        HasBattery        = $false
        EstimatedCharge   = 100
        StatusDescription = 'Desktop Workstation / Direct AC Power'
    }
}

function Get-SarkariTop6Processes {
    $list = @()
    try {
        $procs = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 6
        foreach ($p in $procs) {
            $ramMb = [math]::Round($p.WorkingSet64 / 1MB, 1)
            $list += [pscustomobject]@{
                Rank    = ($list.Count + 1)
                Process = $p.ProcessName
                Id      = $p.Id
                RamMb   = $ramMb
            }
        }
    } catch {
        $list += [pscustomobject]@{ Rank = 1; Process = 'system'; Id = 4; RamMb = 0.0 }
    }
    return @($list)
}

function Get-SarkariTelemetrySnapshot {
    [CmdletBinding()]
    param(
        [string]$Id = $WorkId
    )

    if (-not $Id) {
        $Id = "TELEMETRY-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
    }

    $battery = Get-SarkariBatteryStatus
    $top6 = @(Get-SarkariTop6Processes)
    
    $freeMb = 0
    $totalMb = 0
    $usedPct = 0
    try {
        $os = Get-CimInstance Win32_OperatingSystem
        $freeMb = [math]::Round($os.FreePhysicalMemory / 1024)
        $totalMb = [math]::Round($os.TotalVisibleMemorySize / 1024)
        $usedPct = [math]::Round((($totalMb - $freeMb) / $totalMb) * 100, 1)
    } catch {}

    $snapshot = [pscustomobject]@{
        WorkId          = $Id
        Timestamp       = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        TimestampIso    = (Get-Date).ToUniversalTime().ToString('o')
        BatteryCharge   = $battery.EstimatedCharge
        BatteryStatus   = $battery.StatusDescription
        FreeRamMb       = $freeMb
        TotalRamMb      = $totalMb
        RamUsedPercent  = $usedPct
        Top6Processes   = $top6
    }

    # Save to disk
    $json = $snapshot | ConvertTo-Json -Depth 5
    $filePath = Join-Path $TelemetryDir "$Id.json"
    [System.IO.File]::WriteAllText($filePath, $json, (New-Object System.Text.UTF8Encoding($false)))

    return $snapshot
}

function Show-SarkariTelemetryBanner([pscustomobject]$Snapshot) {
    Write-Host "`n--------------------------------------------------------" -ForegroundColor Cyan
    Write-Host "  📊 SARKARI HARDWARE & PROCESS TELEMETRY AT APPLY TIME" -ForegroundColor Cyan
    Write-Host "--------------------------------------------------------" -ForegroundColor Cyan
    $batColor = if ($Snapshot.BatteryCharge -gt 25) { 'Green' } else { 'Yellow' }
    Write-Host "  Battery:        $($Snapshot.BatteryCharge)% - $($Snapshot.BatteryStatus)" -ForegroundColor $batColor
    $ramColor = if ($Snapshot.FreeRamMb -gt 2000) { 'Green' } else { 'Yellow' }
    Write-Host "  Memory (RAM):   $($Snapshot.FreeRamMb) MB free / $($Snapshot.TotalRamMb) MB total ($($Snapshot.RamUsedPercent)% used)" -ForegroundColor $ramColor
    Write-Host "  Top 6 Memory-Hogging Processes:" -ForegroundColor Yellow
    foreach ($p in $Snapshot.Top6Processes) {
        Write-Host ("    [{0}] {1,-20} (PID {2,-6}) : {3,7} MB RAM" -f $p.Rank, $p.Process, $p.Id, $p.RamMb) -ForegroundColor DarkGray
    }
    Write-Host "--------------------------------------------------------`n" -ForegroundColor Cyan
}

if ($MyInvocation.InvocationName -ne '.') {
    $snap = Get-SarkariTelemetrySnapshot
    Show-SarkariTelemetryBanner -Snapshot $snap
}
