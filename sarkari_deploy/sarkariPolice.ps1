<#
.SYNOPSIS
    Sarkari Police - read-only deployment integrity audit.

.DESCRIPTION
    Separation of powers:
      Police (this script) = investigate and collect evidence
      Court  (sarkariCourt.ps1) = issue and track challans
      Vakil  (sarkariVakil.ps1) = appeal
      User   = final veto

    This script is deliberately read-only. It does not write records, does not
    issue challans, does not kill processes and does not start builds. It reads
    the JSON work orders, the SQLite ledger through the existing status command,
    live build process command lines, the contribution folder and the Court's
    active challans.

.PARAMETER RepoRoot
    Repository root. Defaults to the repository root when run from either
    sarkari_deploy/ or sarkari_open_contribute/drafts/.

.PARAMETER Hours
    Lookback window for work orders. Default 24.

.PARAMETER Json
    Emit one machine-readable JSON object instead of the console FIR.

.PARAMETER IncludeCleared
    List inspected-but-cleared items (for example dry tests).

.NOTES
    Exit codes:
      0 = no high/critical finding
      1 = at least one HIGH finding
      2 = at least one CRITICAL finding
      3 = audit could not read its primary inputs
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [int]$Hours = 24,
    [switch]$Json,
    [switch]$IncludeCleared
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
    # Works from both locations: sarkari_deploy/ (one level below the repo)
    # and sarkari_open_contribute/drafts/ (two levels below the repo).
    $parent = Split-Path -Parent $PSScriptRoot
    if (Test-Path (Join-Path $parent 'sarkari_deploy')) {
        $RepoRoot = $parent
    } else {
        $RepoRoot = Split-Path -Parent $parent
    }
}
if ($Hours -lt 1) { $Hours = 24 }

$recordsDir = Join-Path $RepoRoot 'sarkari_deploy\records'
$contribDir = Join-Path $RepoRoot 'sarkari_open_contribute'
$appDir = Join-Path $RepoRoot 'Clipchamp_Bunny'
$ledgerScript = Join-Path $appDir 'tools\deploy-ledger.mjs'
$now = Get-Date
$since = $now.AddHours(-1 * $Hours)

$findings = New-Object System.Collections.Generic.List[object]
$cleared = New-Object System.Collections.Generic.List[object]

function Add-Finding {
    param(
        [string]$Code,
        [ValidateSet('CRITICAL', 'HIGH', 'MEDIUM', 'INFO')][string]$Severity,
        [string]$Subject,
        [string]$Evidence,
        [string]$Message,
        [string]$Action
    )
    $findings.Add([pscustomobject]@{
            Code     = $Code
            Severity = $Severity
            Subject  = $Subject
            Evidence = $Evidence
            Message  = $Message
            Action   = $Action
        })
}

function Read-JsonFile {
    param([string]$Path)
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
        if (-not $raw) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Convert-SarkariTime {
    param([string]$Text)
    if (-not $Text) { return $null }
    try {
        return [datetime]::ParseExact(
            $Text,
            'yyyy-MM-dd HH:mm:ss',
            [Globalization.CultureInfo]::InvariantCulture
        )
    } catch {
        return $null
    }
}

function Find-PythonFiles {
    param([string]$Root)
    $excluded = @('node_modules', 'target', 'dist', '.git', '.venv', 'venv', '__pycache__', '.next', '.svelte-kit')
    $stack = New-Object System.Collections.Stack
    $stack.Push($Root)
    $found = New-Object System.Collections.Generic.List[string]
    while ($stack.Count -gt 0) {
        $dir = [string]$stack.Pop()
        try {
            foreach ($file in [System.IO.Directory]::EnumerateFiles($dir, '*.py')) {
                $found.Add($file)
            }
            foreach ($sub in [System.IO.Directory]::EnumerateDirectories($dir)) {
                $name = [System.IO.Path]::GetFileName($sub)
                if ($excluded -notcontains $name) { $stack.Push($sub) }
            }
        } catch {
            # A protected folder must not stop the audit.
        }
    }
    return $found
}

function Get-ContributionIndex {
    param([string]$Root)
    $items = New-Object System.Collections.Generic.List[object]
    $propDir = Join-Path $Root 'proposals'
    $draftDir = Join-Path $Root 'drafts'

    if (Test-Path $propDir) {
        foreach ($f in @(Get-ChildItem -LiteralPath $propDir -Filter '*.md' -File -ErrorAction SilentlyContinue)) {
            if ($f.Name -eq 'template_proposal.md') { continue }
            $head = @(Get-Content -LiteralPath $f.FullName -TotalCount 40 -ErrorAction SilentlyContinue) -join "`n"
            $author = ''
            $m = [regex]::Match($head, '(?im)^\s*-\s*\*\*Author Agent:\*\*\s*`?([^`\r\n]+)')
            if ($m.Success) { $author = $m.Groups[1].Value.Trim() }
            $items.Add([pscustomobject]@{
                    Kind     = 'proposal'
                    File     = $f.Name
                    Author   = $author
                    # Match only identity metadata, never the proposal body:
                    # a body mention (for example "Antigravity-Agent") must not
                    # turn an unrelated agent into a contributor.
                    Haystack = ($f.Name + "`n" + $author)
                })
        }
    }

    if (Test-Path $draftDir) {
        foreach ($f in @(Get-ChildItem -LiteralPath $draftDir -File -ErrorAction SilentlyContinue)) {
            $head = @(Get-Content -LiteralPath $f.FullName -TotalCount 40 -ErrorAction SilentlyContinue) -join "`n"
            $items.Add([pscustomobject]@{
                    Kind     = 'draft'
                    File     = $f.Name
                    Author   = ''
                    Haystack = ($f.Name)
                })
        }
    }

    return $items
}

# ---------------------------------------------------------------- work orders
$allRecords = New-Object System.Collections.Generic.List[object]
if (Test-Path $recordsDir) {
    foreach ($f in @(Get-ChildItem -LiteralPath $recordsDir -Filter 'SARKARI-*.json' -File -ErrorAction SilentlyContinue)) {
        $r = Read-JsonFile $f.FullName
        if ($r -and $r.workId) { $allRecords.Add($r) }
    }
}

$records = @($allRecords | Where-Object {
        $d = Convert-SarkariTime ([string]$_.kabStartTime)
        $d -and $d -ge $since
    })
$failed = @($records | Where-Object { [string]$_.outcome -eq 'FAILED' })
$success = @($records | Where-Object { @('SHIPPED', 'STAGED') -contains [string]$_.outcome })

# The JSON records are written for failures and dry tests; successful deploys
# live in the SQLite ledger. Read the ledger early so "no success" is never a
# JSON-only claim.
$ledgerStatus = $null
$ledgerError = ''
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and (Test-Path $ledgerScript)) {
    try {
        $raw = (& $node.Source $ledgerScript status --json 2>&1 | Out-String)
        $start = $raw.IndexOf('{')
        if ($start -ge 0) {
            $ledgerStatus = $raw.Substring($start) | ConvertFrom-Json
        } else {
            $ledgerError = $raw.Trim()
        }
    } catch {
        $ledgerError = $_.Exception.Message
    }
} else {
    $ledgerError = 'node or deploy-ledger.mjs not found'
}

$active = $null
$queueDepth = $null
if ($ledgerStatus) {
    $active = $ledgerStatus.active
    $queueDepth = $ledgerStatus.queueDepth
}

$ledgerShipped = @()
if ($ledgerStatus -and $ledgerStatus.recent) {
    $ledgerShipped = @($ledgerStatus.recent | Where-Object {
            @('shipped', 'staged') -contains [string]$_.status
        })
}

foreach ($r in $records) {
    $agent = [string]$r.agent
    $model = [string]$r.modelName
    $outcome = [string]$r.outcome
    $err = [string]$r.error
    $unknown = ($agent -match '(?i)unknown') -or ($model -match '(?i)unknown') -or [string]::IsNullOrWhiteSpace($agent)

    if (-not $unknown) { continue }

    if ($outcome -eq 'TEST' -or $err -match '(?i)dry test') {
        $cleared.Add([pscustomobject]@{
                Code     = 'DRY_TEST_CLEARED'
                Subject  = "$agent / $model"
                Evidence = [string]$r.workId
                Message  = 'Dry test record; no build, install or deployment. Not an offense.'
            })
        continue
    }

    Add-Finding -Code 'UNPROFILED_EXECUTION' -Severity 'HIGH' `
        -Subject "$agent / $model" `
        -Evidence ([string]$r.workId) `
        -Message ("Real order has no usable agent/model profile (outcome: {0})." -f $outcome) `
        -Action 'Investigate the caller; do not issue a challan without user approval.'
}

$failedGroups = @($failed | Group-Object { ([string]$_.agent) + '|' + ([string]$_.modelName) })
foreach ($g in $failedGroups) {
    if ($g.Count -lt 2) { continue }
    $first = $g.Group[0]
    $agent = [string]$first.agent
    $model = [string]$first.modelName
    if ($agent -match '(?i)unknown' -or $model -match '(?i)unknown') { continue }

    $hasSuccess = @($success | Where-Object {
            [string]$_.agent -eq $agent -and [string]$_.modelName -eq $model
        }).Count -gt 0
    if ($hasSuccess) { continue }

    $ids = @($g.Group | ForEach-Object { [string]$_.workId }) -join ', '
    $errors = @($g.Group | ForEach-Object { [string]$_.error } | Where-Object { $_ } | Select-Object -Unique) -join ' | '

    # A successful deploy is written to the SQLite ledger, not to the JSON
    # failure record. If the same agent/model shipped after the first failure,
    # it recovered and must not be labelled "no success".
    $firstFailureTime = Convert-SarkariTime ([string]$first.kabStartTime)
    $ledgerRecovered = $false
    foreach ($ship in $ledgerShipped) {
        if ([string]$ship.agent -ne $agent -or [string]$ship.model -ne $model) { continue }
        if (-not $firstFailureTime) { $ledgerRecovered = $true; break }
        try {
            $finishUtc = [datetime]::Parse(
                [string]$ship.finishedAt,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::AdjustToUniversal
            )
            if ($finishUtc.ToLocalTime() -ge $firstFailureTime) {
                $ledgerRecovered = $true
                break
            }
        } catch {
            # An unreadable timestamp is not evidence of recovery.
        }
    }
    if ($ledgerRecovered) { continue }

    # These are not real model runs: they are the engine's hardcoded default
    # profile failing because the dot-source lost AgentProfile. Do not blame
    # a model for the caller's parameter bug.
    $engineDefault = @($g.Group | Where-Object {
            [string]$_.error -match '(?i)AgentProfile' -or $agent -match '(?i)Antigravity'
        })
    if ($engineDefault.Count -eq $g.Count) {
        Add-Finding -Code 'ENGINE_DEFAULT_AGENT' -Severity 'INFO' `
            -Subject "$agent / $model" `
            -Evidence $ids `
            -Message 'All failures are the engine default profile / missing AgentProfile, not a real model run.' `
            -Action 'Fix the dot-source parameter forwarding; do not issue a model challan.'
        continue
    }
    Add-Finding -Code 'REPEATED_FAILURES' -Severity 'MEDIUM' `
        -Subject "$agent / $model" `
        -Evidence $ids `
        -Message ("{0} failed orders in {1}h with no shipped/staged success after the first failure. Errors: {2}" -f $g.Count, $Hours, $errors) `
        -Action 'Inspect the failures; a build/dist race can look like a code failure.'
}

# --------------------------------------------------------------- live builds
# There is no local build lane any more: every compile happens in CI, and the
# only thing this machine runs is the ledger-locked install. This scan is the
# audit half of that rule: the cargo shim blocks `cargo build`, but it cannot
# see a direct `rustc`, a `tauri build` launched through node, or an agent that
# exported T9_ALLOW_LOCAL_RUST. Those are exactly the escapes worth finding.
$liveBuilds = @()
$distinctWorkIds = @()
try {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $byId = @{}
    foreach ($p in $processes) { $byId[[int]$p.ProcessId] = $p }

    foreach ($p in $processes) {
        $cmd = [string]$p.CommandLine
        if (-not $cmd) { continue }
        $why = $null

        if ($p.Name -match '(?i)^cargo(\.exe)?$' -and $cmd -match '(?i)(^|\s)(build|test|clippy|bench)(\s|$)') {
            $why = 'cargo compile command (build/test/clippy/bench)'
        } elseif ($p.Name -match '(?i)^rustc(\.exe)?$') {
            $parent = $byId[[int]$p.ParentProcessId]
            $parentCmd = if ($parent) { [string]$parent.CommandLine } else { '' }
            # `cargo check` is allowed and runs rustc with --emit=metadata.
            # A rustc whose parent is not that check is a compile.
            if (-not ($parentCmd -match '(?i)cargo(\.exe)?\s+check(\s|$)') -and
                -not ($cmd -match '(?i)--emit(=\s*|\s+)metadata(\s|$)')) {
                $why = 'direct rustc compile'
            }
        } elseif ($cmd -match '(?i)tauri(\.js)?["'']?\s+build(\s|$)') {
            $why = 'tauri build'
        }

        if ($why) {
            $liveBuilds += [pscustomobject]@{
                ProcessId = [int]$p.ProcessId
                Name      = [string]$p.Name
                Reason    = $why
                CommandLine = $cmd
            }
        }
    }

    if ($liveBuilds.Count -gt 0) {
        Add-Finding -Code 'LOCAL_RUST_COMPILE' -Severity 'HIGH' `
            -Subject 'Live process table' `
            -Evidence (($liveBuilds | ForEach-Object { "$($_.ProcessId) $($_.Name): $($_.Reason)" }) -join '; ') `
            -Message 'A local Rust/Tauri compile is running. Compilation belongs to CI; local release builds are banned on this 8 GB machine.' `
            -Action 'Stop it and move the compile to CI. `cargo check` is the only allowed local Rust command.'
    }
    if ($env:T9_ALLOW_LOCAL_RUST) {
        Add-Finding -Code 'LOCAL_RUST_ESCAPE_HATCH' -Severity 'HIGH' `
            -Subject 'Environment' -Evidence 'T9_ALLOW_LOCAL_RUST is set' `
            -Message 'The local-compile escape hatch is active; a build started from this environment can bypass the cargo shim.' `
            -Action 'Unset T9_ALLOW_LOCAL_RUST. It is for a deliberate, watched exception only.'
    }
} catch {
    Add-Finding -Code 'PROCESS_SCAN_FAILED' -Severity 'INFO' `
        -Subject 'Process table' -Evidence $_.Exception.Message `
        -Message 'Could not inspect live processes; the local-compile check is incomplete.' `
        -Action 'Re-run sarkariPolice.ps1 with permission to read Win32_Process.'
}

# ------------------------------------------------------------------- ledger
if (-not $ledgerStatus) {
    Add-Finding -Code 'LEDGER_UNREADABLE' -Severity 'MEDIUM' `
        -Subject 'SQLite ledger' -Evidence $ledgerError `
        -Message 'Could not read the shared ledger; the audit is incomplete.' `
        -Action 'Run deploy.ps1 -Status manually before trusting this report.'
}

# ------------------------------------------------------------------- Python
$pythonFiles = @(Find-PythonFiles -Root $RepoRoot)
if ($pythonFiles.Count -gt 0) {
    Add-Finding -Code 'PYTHON_BANNED' -Severity 'CRITICAL' `
        -Subject 'Repository' -Evidence ($pythonFiles -join '; ') `
        -Message 'Python files are banned by the repository constitution.' `
        -Action 'Issue PYTHON_BANNED_VIOLATION only after user approval; see sarkariCourt.ps1.'
}

# ----------------------------------------------------------- contributions
$contribs = @(Get-ContributionIndex -Root $contribDir)
$proposalContribs = @($contribs | Where-Object { $_.Kind -eq 'proposal' })
$draftContribs = @($contribs | Where-Object { $_.Kind -eq 'draft' })

$contributorRows = @($proposalContribs | Where-Object { $_.Author } |
        Group-Object { $_.Author } |
        Sort-Object Count -Descending |
        ForEach-Object {
            [pscustomobject]@{ Author = $_.Name; Proposals = $_.Count }
        })

$subjects = @($records |
        Where-Object {
            [string]$_.agent -notmatch '(?i)unknown' -and
            [string]$_.modelName -notmatch '(?i)unknown'
        } |
        Group-Object { ([string]$_.agent) + '|' + ([string]$_.modelName) })

$contributionRows = @()
foreach ($s in $subjects) {
    $first = $s.Group[0]
    $agent = [string]$first.agent
    $model = [string]$first.modelName
    $tail = ($model -split '/')[-1]
    $tokens = @($agent, $tail, $model) | Where-Object { $_ } | Select-Object -Unique

    $hits = @($contribs | Where-Object {
            $hay = $_.Haystack
            $match = $false
            foreach ($t in $tokens) {
                if ($hay -match [regex]::Escape($t)) { $match = $true; break }
            }
            $match
        })

    $contributionRows += [pscustomobject]@{
        Agent   = $agent
        Model   = $model
        Matches = $hits.Count
        Files   = @($hits | ForEach-Object { $_.File }) -join ', '
    }

    if ($hits.Count -eq 0) {
        Add-Finding -Code 'NO_CONTRIBUTION_ON_RECORD' -Severity 'INFO' `
            -Subject "$agent / $model" -Evidence 'sarkari_open_contribute/' `
            -Message 'No proposal or draft matched this agent in the contribution folder.' `
            -Action 'This is not a violation. Invite a contribution; do not issue a challan.'
    }
}

# -------------------------------------------------------------------- court
$challanDir = Join-Path $recordsDir 'challans'
$activeChallans = @()
if (Test-Path $challanDir) {
    foreach ($f in @(Get-ChildItem -LiteralPath $challanDir -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
        $c = Read-JsonFile $f.FullName
        if ($c -and [string]$c.status -eq 'ACTIVE_PENALTY') { $activeChallans += $c }
    }
}

# ------------------------------------------------------------------ totals
$criticalCount = @($findings | Where-Object { $_.Severity -eq 'CRITICAL' }).Count
$highCount = @($findings | Where-Object { $_.Severity -eq 'HIGH' }).Count
$mediumCount = @($findings | Where-Object { $_.Severity -eq 'MEDIUM' }).Count
$infoCount = @($findings | Where-Object { $_.Severity -eq 'INFO' }).Count

$totals = [pscustomobject]@{
    WindowHours        = $Hours
    Records            = $records.Count
    Failed             = $failed.Count
    Success            = $success.Count
    LedgerShipped      = $ledgerShipped.Count
    LiveBuilds         = $liveBuilds.Count
    DistinctLiveWorkIds = $distinctWorkIds.Count
    Findings           = $findings.Count
    Critical           = $criticalCount
    High               = $highCount
    Medium             = $mediumCount
    Info               = $infoCount
    Proposals          = $proposalContribs.Count
    Drafts             = $draftContribs.Count
    ActiveChallans     = $activeChallans.Count
}

if ($Json) {
    $ledgerObject = [pscustomobject]@{
        active     = $active
        queueDepth = $queueDepth
        error      = $ledgerError
    }
    # Do not use @($findings): this PowerShell build throws
    # "Argument types do not match" when @() wraps a generic List[object].
    $findingsJson = $findings.ToArray()
    $clearedJson = $cleared.ToArray()
    $liveJson = @($liveBuilds | Select-Object Pid, WorkId, Agent, SkipLock)
    $contributionsJson = @($contributionRows)
    $contributorsJson = @($contributorRows)
    $challansJson = @($activeChallans | Select-Object challanId, agent, workId, violation, points, status)

    $result = [ordered]@{
        generatedAt    = $now.ToString('yyyy-MM-dd HH:mm:ss')
        repoRoot       = $RepoRoot
        totals         = $totals
        findings       = $findingsJson
        cleared        = $clearedJson
        liveBuilds     = $liveJson
        contributions  = $contributionsJson
        contributors   = $contributorsJson
        activeChallans = $challansJson
        ledger         = $ledgerObject
    }
    $result | ConvertTo-Json -Depth 8
    if ($criticalCount -gt 0) { exit 2 }
    if ($highCount -gt 0) { exit 1 }
    exit 0
}

# ------------------------------------------------------------------ console
$ledgerLine = if ($ledgerStatus) {
    $activeText = if ($active) { [string]$active.id } else { 'none' }
    "active=$activeText, queue=$queueDepth"
} else {
    'UNREADABLE'
}

Write-Host ''
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host '  SARKARI POLICE - READ-ONLY FIR' -ForegroundColor Cyan
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host ("  Window: last {0}h | Records: {1} | Failed: {2} | Ledger shipped(recent): {3} | Live builds: {4}" -f $Hours, $records.Count, $failed.Count, $ledgerShipped.Count, $liveBuilds.Count) -ForegroundColor Gray
Write-Host ("  Ledger: {0}" -f $ledgerLine) -ForegroundColor Gray
Write-Host ''

$severityOrder = @{ 'CRITICAL' = 0; 'HIGH' = 1; 'MEDIUM' = 2; 'INFO' = 3 }
$sorted = @($findings | Sort-Object { $severityOrder[$_.Severity] }, Code)
foreach ($f in $sorted) {
    $colour = switch ($f.Severity) {
        'CRITICAL' { 'Red' }
        'HIGH' { 'Red' }
        'MEDIUM' { 'Yellow' }
        default { 'Cyan' }
    }
    Write-Host ("[{0}] {1} - {2}" -f $f.Severity, $f.Code, $f.Subject) -ForegroundColor $colour
    Write-Host ("        Evidence: {0}" -f $f.Evidence) -ForegroundColor DarkGray
    Write-Host ("        {0}" -f $f.Message) -ForegroundColor White
    if ($f.Action) { Write-Host ("        Next: {0}" -f $f.Action) -ForegroundColor DarkGray }
}

if ($sorted.Count -eq 0) {
    Write-Host '  No integrity findings.' -ForegroundColor Green
}

if ($IncludeCleared -and $cleared.Count -gt 0) {
    Write-Host ''
    Write-Host 'CLEARED (inspected, not an offense)' -ForegroundColor Green
    foreach ($c in $cleared) {
        Write-Host ("  [OK] {0} - {1}" -f $c.Code, $c.Evidence) -ForegroundColor Green
        Write-Host ("       {0}" -f $c.Message) -ForegroundColor DarkGray
    }
} elseif ($cleared.Count -gt 0) {
    Write-Host ''
    Write-Host ("  Cleared: {0} dry-test record(s). Use -IncludeCleared to list." -f $cleared.Count) -ForegroundColor Green
}

Write-Host ''
Write-Host 'RECOGNITION (contributions are voluntary)' -ForegroundColor Cyan
if ($contributorRows.Count -eq 0) {
    Write-Host '  No proposals found.' -ForegroundColor DarkGray
} else {
    foreach ($r in $contributorRows) {
        Write-Host ("  {0,-45} {1} proposal(s)" -f $r.Author, $r.Proposals) -ForegroundColor Green
    }
}
Write-Host ("  Drafts on file: {0}" -f $draftContribs.Count) -ForegroundColor Green

Write-Host ''
Write-Host 'SUBJECT SCORECARD' -ForegroundColor Cyan
foreach ($r in $contributionRows) {
    $colour = if ($r.Matches -gt 0) { 'Green' } else { 'DarkGray' }
    Write-Host ("  {0} / {1} -> {2} match(es)" -f $r.Agent, $r.Model, $r.Matches) -ForegroundColor $colour
}

Write-Host ''
if ($activeChallans.Count -gt 0) {
    Write-Host ("COURT: {0} active challan(s)" -f $activeChallans.Count) -ForegroundColor Yellow
    foreach ($c in $activeChallans) {
        Write-Host ("  {0}  {1}  {2} pts  {3}" -f $c.challanId, $c.agent, $c.points, $c.violation) -ForegroundColor Yellow
    }
} else {
    Write-Host 'COURT: no active challans.' -ForegroundColor Green
}

Write-Host ''
Write-Host '--------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ("VERDICT: {0} critical, {1} high, {2} medium, {3} info" -f $criticalCount, $highCount, $mediumCount, $infoCount) -ForegroundColor Cyan
if ($criticalCount -gt 0) {
    Write-Host '  ACTION: critical finding. User decision required before any Court challan.' -ForegroundColor Red
} elseif ($highCount -gt 0) {
    Write-Host '  ACTION: investigate the high findings. No automatic punishment.' -ForegroundColor Yellow
} else {
    Write-Host '  No blocking integrity issue found.' -ForegroundColor Green
}
Write-Host '  Police never issues challans. Court + user approval required.' -ForegroundColor DarkGray
Write-Host ''

if ($criticalCount -gt 0) { exit 2 }
if ($highCount -gt 0) { exit 1 }
exit 0
