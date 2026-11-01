<#
.SYNOPSIS
    Download speed audit for T9 Editor LIT.

.DESCRIPTION
    The downloader itself lives in the Go daemon (`t9cloud`): one file is
    fetched with up to 16 parallel Range connections, and every 64 KiB goes
    straight to disk. That is where the speed comes from, and it runs on its
    own for every download - there is nothing for a script to do per file.

    What a script CAN do is check the three things on this machine that cap a
    fast downloader:

      1. Receive Window Auto-Tuning  - "restricted"/"disabled" caps a single
         TCP stream, and no number of sockets fixes a clamped receive window.
      2. Defender real-time scanning - every chunk written to the `.part` file
         is scanned; a 9.6 GB download is scanned while it is being written.
      3. The power plan - "Power saver" parks cores and throttles the NIC.

    Without -Apply this only reports. With -Apply (Administrator) it fixes 1
    and 2, which are the two that measurably matter.

.EXAMPLE
    pwsh -File tools\dl-boost.ps1

.EXAMPLE
    # Administrator
    pwsh -File tools\dl-boost.ps1 -Apply
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$DownloadDir = (Join-Path $env:USERPROFILE 'Downloads')
)

$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Line([string]$tag, [string]$text, [string]$colour = 'Gray') {
    Write-Host ("  [{0}] {1}" -f $tag, $text) -ForegroundColor $colour
}

Write-Host ''
Write-Host '  T9 Editor LIT - download speed audit' -ForegroundColor Cyan
Write-Host '  -----------------------------------' -ForegroundColor DarkGray

# ── 1. the daemon and its own measurement ──────────────────────────────────
$daemonUp = $false
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:7878/healthz' -TimeoutSec 2
    $daemonUp = $true
    Line 'ok' "t9cloud daemon: running (version $($health.version))" 'Green'
}
catch {
    Line '!!' 't9cloud daemon: not answering on 127.0.0.1:7878' 'Yellow'
    Line '  ' 'start the app once - it brings the daemon up and keeps it up' 'DarkGray'
}

if ($daemonUp) {
    try {
        $speed = Invoke-RestMethod -Uri 'http://127.0.0.1:7878/v1/net/speed' -TimeoutSec 25
        Line 'ok' ("link speed now: {0:N1} Mbps ({1:N1} MB/s)" -f $speed.mbps, $speed.megabytesPerSec) 'Green'
        if ($speed.megabytesPerSec -lt 2) {
            Line '!!' 'under 2 MB/s - check Wi-Fi signal / another device on the line' 'Yellow'
        }
    }
    catch {
        Line '!!' 'speed test failed (the endpoint needs internet)' 'Yellow'
    }
}

# ── 2. receive window auto-tuning ──────────────────────────────────────────
$tuning = 'unknown'
try {
    $global = netsh int tcp show global
    $match = $global | Select-String -Pattern 'Auto-Tuning Level\s*:\s*(\S+)'
    if ($match) { $tuning = $match.Matches[0].Groups[1].Value }
}
catch { }

switch ($tuning) {
    'normal' { Line 'ok' 'TCP auto-tuning: normal' 'Green' }
    'unknown' { Line '!!' 'TCP auto-tuning: could not read' 'Yellow' }
    default {
        Line '!!' "TCP auto-tuning: $tuning (this caps a single connection)" 'Yellow'
        if ($Apply -and $isAdmin) {
            netsh int tcp set global autotuninglevel=normal | Out-Null
            Line 'ok' 'set to normal - takes effect immediately' 'Green'
        }
        elseif ($Apply) {
            Line '  ' 'needs Administrator to change' 'DarkGray'
        }
    }
}

# ── 3. Defender scanning the file while it is written ──────────────────────
$excluded = $false
try {
    $prefs = Get-MpPreference
    $paths = @($prefs.ExclusionPath | Where-Object { $_ })
    $excluded = $paths | Where-Object { $DownloadDir.TrimEnd('\') -like "$($_.TrimEnd('\'))*" }
}
catch {
    Line '  ' 'Defender preferences unavailable (third-party AV?)' 'DarkGray'
}

if ($excluded) {
    Line 'ok' "Defender: $DownloadDir is excluded (no scan per chunk)" 'Green'
}
else {
    Line '!!' "Defender: every chunk written to $DownloadDir is scanned" 'Yellow'
    if ($Apply -and $isAdmin) {
        Add-MpPreference -ExclusionPath $DownloadDir
        Line 'ok' "excluded $DownloadDir - downloads are no longer scanned mid-write" 'Green'
        Line '  ' 'trade-off: files in that folder are not scanned on write' 'DarkGray'
    }
    elseif ($Apply) {
        Line '  ' 'needs Administrator to change' 'DarkGray'
    }
}

# ── 4. power plan ──────────────────────────────────────────────────────────
try {
    $plan = (powercfg /getactivescheme) -join ' '
    if ($plan -match '([0-9a-f-]{36})') {
        $guid = $Matches[1]
        $name = ($plan -split '\(|\)')[1]
        if ($name -match 'Power saver|Battery saver') {
            Line '!!' "power plan: $name (throttles the network adapter)" 'Yellow'
            Line '  ' 'switch to Balanced for big downloads: powercfg /setactive SCHEME_BALANCED' 'DarkGray'
        }
        else {
            Line 'ok' "power plan: $name" 'Green'
        }
    }
}
catch { }

Write-Host ''
if (-not $Apply) {
    Write-Host '  Nothing was changed. Re-run with -Apply (as Administrator) to fix the' -ForegroundColor DarkGray
    Write-Host '  items marked [!!]. The downloader itself needs no script: it already' -ForegroundColor DarkGray
    Write-Host '  opens up to 16 connections per file, every time.' -ForegroundColor DarkGray
    Write-Host ''
}
