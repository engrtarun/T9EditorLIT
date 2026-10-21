<#
.SYNOPSIS
    Read-only guard for the 10 big performance/RAM problems staged in proposals/.

.DESCRIPTION
    This helper scans the codebase for the patterns behind the 10 proposals:
      1. Job polling deep-clones transcripts + high retention
      2. Queue workers use context.Background() (no cancel/timeout)
      3. Per-poll HTTP Info logging
      4. SQLite opened per Tauri command
      5. Encoder detection uncached
      6. FFmpeg run() buffering full output
      7. Vault upload streaming/hash pressure
      8. Transcript DOM not virtualized
      9. Export path buffering risk
     10. Memory probe full scan too frequent

    It changes nothing. It only reports status so reviewers can see whether each
    problem still exists in the current tree.

.PARAMETER RepoRoot
    Repository root. Defaults to two levels above this draft folder.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

function Test-Pattern {
    param(
        [string]$Label,
        [string]$Path,
        [string]$Pattern,
        [bool]$BadIfFound = $true
    )
    if (-not (Test-Path $Path)) {
        return [pscustomobject]@{ Label = $Label; Status = 'SKIP'; Detail = "missing: $Path" }
    }
    $hits = Select-String -Path $Path -Pattern $Pattern -ErrorAction SilentlyContinue
    $found = ($hits.Count -gt 0)
    $bad = if ($BadIfFound) { $found } else { -not $found }
    return [pscustomobject]@{
        Label  = $Label
        Status = if ($bad) { 'NEEDS_FIX' } else { 'OK' }
        Detail = if ($found) { "found '$Pattern'" } else { "not found '$Pattern'" }
    }
}

$rows = @()
$rows += Test-Pattern '1. jobStore clone/retention' (Join-Path $RepoRoot 'go\internal\api\store.go') 'maxRetainedJobs = 256'
$rows += Test-Pattern '2. queue context.Background' (Join-Path $RepoRoot 'go\internal\queue\queue.go') 'context\.Background\(\)'
$rows += Test-Pattern '3. per-poll Info log' (Join-Path $RepoRoot 'go\internal\api\server.go') 's\.deps\.Log\.Info\("request"'
$rows += Test-Pattern '4. SQLite open per command' (Join-Path $RepoRoot 'src-tauri\src\lib.rs') 'open_db\('
$rows += Test-Pattern '5. encoder cache missing' (Join-Path $RepoRoot 'src-tauri\src\ffmpeg.rs') 'fn ffmpeg_has_encoder'
$rows += Test-Pattern '6. FFmpeg run buffering' (Join-Path $RepoRoot 'src-tauri\src\ffmpeg.rs') '\.output\(\)'
$rows += Test-Pattern '7. vault upload pressure' (Join-Path $RepoRoot 'go\internal\vault\vault.go') 'io\.ReadAll'
$rows += Test-Pattern '8. transcript DOM virtualization' (Join-Path $RepoRoot 'Clipchamp_Bunny\src\lib\components\cut\TranscriptPanel.svelte') 'virtual'
$rows += Test-Pattern '9. export buffering risk' (Join-Path $RepoRoot 'src-tauri\src\export.rs') '\.output\(\)'
$rows += Test-Pattern '10. memory probe full scan' (Join-Path $RepoRoot 'src-tauri\src\memory.rs') '% 8 == 0'

Write-Host ''
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host '  SARKARI 10 BIG PROBLEMS GUARD (read-only)' -ForegroundColor Cyan
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host "  Repo: $RepoRoot"
Write-Host ''

$badCount = 0
foreach ($row in $rows) {
    $colour = if ($row.Status -eq 'OK') { 'Green' } elseif ($row.Status -eq 'SKIP') { 'Yellow' } else { 'Red' }
    Write-Host ("  [{0,-10}] {1,-42} {2}" -f $row.Status, $row.Label, $row.Detail) -ForegroundColor $colour
    if ($row.Status -eq 'NEEDS_FIX') { $badCount++ }
}

Write-Host ''
if ($badCount -gt 0) {
    Write-Host "  [i] $badCount item(s) still need review/fix." -ForegroundColor Yellow
    Write-Host '  See sarkari_open_contribute/proposals/ for details.' -ForegroundColor DarkGray
    exit 1
}

Write-Host '  [ok] No obvious pattern hits for the 10 tracked problems.' -ForegroundColor Green
Write-Host ''
exit 0