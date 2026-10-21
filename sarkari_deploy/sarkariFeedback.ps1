<#
.SYNOPSIS
    Sarkari Feedback & Grievance Portal (sarkariFeedback.ps1)

.DESCRIPTION
    Yeh module agents aur users ko 3 cheezein darj karne ki suvidha deta hai:
      [1] SUJHAAV   (Suggestions for system improvements)
      [2] SHIKAYAT  (Complaints & Bugs encountered)
      [3] SAMIKSHA  (Reviews & 1 to 5 Star Ratings)
    Sabhi feedback transparently recorded hote hain taaki system evolve ho sake.
#>
[CmdletBinding()]
param(
    [ValidateSet('SUJHAAV', 'SHIKAYAT', 'SAMIKSHA', '')]
    [string]$Type = '',
    [string]$Author = '',
    [string]$Topic = '',
    [string]$Message = '',
    [ValidateRange(1, 5)]
    [int]$Rating = 5,
    [switch]$List,
    [switch]$Interactive
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SarkariDir = $PSScriptRoot
$FeedbackDir = Join-Path $SarkariDir 'records\feedback'
New-Item -ItemType Directory -Force -Path $FeedbackDir | Out-Null

function Show-FeedbackDocket {
    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "  📬 SARKARI FEEDBACK, GRIEVANCE & REVIEW DOCKET" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
    
    $files = @(Get-ChildItem -Path $FeedbackDir -Filter 'FB-*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 10)
    if ($files.Count -eq 0) {
        Write-Host "  No feedback submitted yet. Be the first to submit a suggestion or review!" -ForegroundColor DarkGray
    } else {
        foreach ($f in $files) {
            try {
                $item = Get-Content -Path $f.FullName -Raw | ConvertFrom-Json
                $color = if ($item.type -eq 'SUJHAAV') { 'Cyan' } elseif ($item.type -eq 'SHIKAYAT') { 'Red' } else { 'Yellow' }
                $stars = if ($item.type -eq 'SAMIKSHA') { ("★" * $item.rating) + ("☆" * (5 - $item.rating)) } else { '' }
                Write-Host "  [$($item.type)] $($item.topic) $stars" -ForegroundColor $color
                Write-Host "      By:   $($item.author) on $($item.submittedAt) IST" -ForegroundColor Gray
                Write-Host "      Note: $($item.message)`n" -ForegroundColor White
            } catch {}
        }
    }
    Write-Host "========================================================`n" -ForegroundColor Cyan
}

function Invoke-FeedbackInteractive {
    Write-Host "`n╔════════════════════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║        📬 SARKARI SUJHAAV, SHIKAYAT AUR SAMIKSHA PORTAL 📬                     ║" -ForegroundColor Cyan
    Write-Host "╚════════════════════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
    
    Write-Host "Select Category:" -ForegroundColor Yellow
    Write-Host "  [1] SUJHAAV   (System ko behtar banane ka suggestion)" -ForegroundColor Cyan
    Write-Host "  [2] SHIKAYAT  (Koi pareshani ya bug ki complaint)" -ForegroundColor Red
    Write-Host "  [3] SAMIKSHA  (Overall experience review aur star rating)" -ForegroundColor Yellow
    $c = Read-Host "Choice (1-3) [1]"
    $script:Type = switch ($c) {
        '2' { 'SHIKAYAT' }
        '3' { 'SAMIKSHA' }
        default { 'SUJHAAV' }
    }

    if (-not $script:Author) {
        $defAuthor = if ($env:T9_AGENT) { $env:T9_AGENT } else { 'Dev/User' }
        $ans = Read-Host "Aapka Naam / Agent Identity [$defAuthor]"
        $script:Author = if ($ans) { $ans } else { $defAuthor }
    }

    $ans = Read-Host "Topic / Title (min 5 chars)"
    $script:Topic = $ans

    $ans = Read-Host "Detailed Message / Description (min 10 chars)"
    $script:Message = $ans

    if ($script:Type -eq 'SAMIKSHA') {
        $ans = Read-Host "Star Rating (1 to 5 stars) [5]"
        $script:Rating = if ($ans -match '^[1-5]$') { [int]$ans } else { 5 }
    }
}

function Submit-SarkariFeedback {
    [CmdletBinding()]
    param()

    if ($List) {
        Show-FeedbackDocket
        return
    }

    if ($Interactive -or (-not $script:Type) -or (-not $script:Topic) -or (-not $script:Message)) {
        Invoke-FeedbackInteractive
    }

    if (-not $script:Author) { $script:Author = 'Anonymous-Agent' }
    if ($script:Topic.Length -lt 4) { throw "Topic is too short (min 4 chars)." }
    if ($script:Message.Length -lt 8) { throw "Message is too short (min 8 chars)." }

    $fbId = "FB-$((Get-Date).ToString('yyyyMMdd-HHmmss'))-$([math]::Abs((Get-Random) % 9000 + 1000))"
    $record = [ordered]@{
        schema         = 1
        feedbackId     = $fbId
        type           = $script:Type
        author         = $script:Author
        topic          = $script:Topic
        message        = $script:Message
        rating         = if ($script:Type -eq 'SAMIKSHA') { $script:Rating } else { $null }
        submittedAt    = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        submittedAtIso = (Get-Date).ToUniversalTime().ToString('o')
    }

    $json = $record | ConvertTo-Json -Depth 5
    $filePath = Join-Path $FeedbackDir "$fbId.json"
    [System.IO.File]::WriteAllText($filePath, $json, (New-Object System.Text.UTF8Encoding($false)))

    $color = if ($script:Type -eq 'SUJHAAV') { 'Cyan' } elseif ($script:Type -eq 'SHIKAYAT') { 'Red' } else { 'Yellow' }
    Write-Host "`n  [ok] $script:Type Submitted Successfully! (Record ID: $fbId)" -ForegroundColor $color
    Write-Host "       Aapka yogdaan/feedback Sarkari records me darj kar liya gaya hai.`n" -ForegroundColor DarkGray
    return $record
}

if ($MyInvocation.InvocationName -ne '.') {
    $null = Submit-SarkariFeedback
}
