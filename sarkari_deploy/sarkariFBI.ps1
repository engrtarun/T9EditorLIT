<#
.SYNOPSIS
    Sarkari FBI - the anti-local-compilation bureau of instruction.

.DESCRIPTION
    This script exists to do exactly three things:

      1. SAMJHAYE    - teach every agent (and the user) that this machine is an
                       8 GB i3 with ~1 GB free RAM. Heavy work here (Rust/Tauri
                       release builds) kills the box, the build lock, and the
                       other 5-7 agents sharing it. The compile belongs to the
                       GitHub CI/CD runners, and the install belongs to
                       deploy.ps1's ledger-locked queue.
      2. PATROL KARE - scan the live process table for local compiling that
                       slipped past the cargo shim (direct rustc, `tauri build`
                       through node, an open T9_ALLOW_LOCAL_RUST hatch), collect
                       the evidence, and log a FIR.
      3. DOCTOR BANE - verify the guardrails are actually in place: the cargo
                       shim exists, sits ahead of the real cargo in PATH, and
                       really refuses; the CI workflows and the deploy door
                       exist; nothing was left open by accident.

    Separation of powers (who does what):
      cargo shim (.cargo-shim)     = the wall - physically refuses compiles
      Police (sarkariPolice.ps1)   = warm audit (it records data, does not kill)
      FBI     (this script)        = teach + patrol + kill a live compile (-Bust)
      Court   (sarkariCourt.ps1)   = issues challans, with user approval
      Deploy  (deploy.ps1)         = installs from CI's artifact, ledger-locked

    Multi CI/CD support: this repo carries SEVERAL workflows
    (.github/workflows/*.yml). `ci.yml` is the gate/frontend/rust/go/installer
    lane; `sarkari-artifact.yml` publishes the installable artifact to the
    `ci-latest` / `ci-<sha>` releases. `-Ci` reports what exists and what those
    workflows are doing right now, from the GitHub API (or with a graceful
    pointer to the GitHub MCP when no token is available).

    AGENTS.md is the written law (sections 8, 10, 11). This script is the
    officer who repeats it to whoever forgot.

.PARAMETER RepoRoot
    Repository root. Defaults to the parent of sarkari_deploy/.

.PARAMETER Agent
    Who is running the scan, for the FIR log (for example 'opencode/beam-free').

.PARAMETER Teach
    Print the full induction lesson and exit 0.

.PARAMETER Doctor
    Inspect the guardrails (shim, PATH, escape hatch, workflows, deploy door).

.PARAMETER Ci
    Multi CI/CD status: list every workflow and, when a GitHub token is
    available, the latest runs of each.

.PARAMETER Bust
    Patrol, then FORCE-KILL the compile processes found (children first).
    Without -Yes it asks one confirmation; with -Yes it kills everything at once.

.PARAMETER Yes
    With -Bust: do not ask; kill immediately.

.PARAMETER Json
    Emit one machine-readable JSON object instead of the console report.

.PARAMETER IncludeAllowed
    Patrol: also list the rediscovered allowed-flight clearances.

.NOTES
    Exit codes:
      0 = clean / info modes succeeded
      1 = red violation found (local compiling, open hatch)
      2 = doctor found a broken or missing guardrail
      3 = the scan could not run (process table unreadable)

    The FIR log is appended to sarkari_deploy\records\fbi\fbi-log.jsonl.
    It is trimmed to its last 200 lines when it grows past 512 KB.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$Agent = 'unknown',
    [switch]$Teach,
    [switch]$Doctor,
    [switch]$Ci,
    [switch]$Bust,
    [switch]$Yes,
    [switch]$Json,
    [switch]$IncludeAllowed
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
    # Same resolution trick as sarkariPolice.ps1: repo root sits one level
    # above sarkari_deploy/; two levels above sarkari_open_contribute/drafts/.
    $parent = Split-Path -Parent $PSScriptRoot
    if (Test-Path (Join-Path $parent 'sarkari_deploy')) { $RepoRoot = $parent }
    else { $RepoRoot = Split-Path -Parent $parent }
}

$shimPath   = Join-Path $env:USERPROFILE '.cargo-shim\cargo.cmd'
$ciYml      = Join-Path $RepoRoot '.github\workflows\ci.yml'
$artiYml    = Join-Path $RepoRoot '.github\workflows\sarkari-artifact.yml'
$deployPs1  = Join-Path $RepoRoot 'Clipchamp_Bunny\tools\deploy.ps1'
$ledgerMjs  = Join-Path $RepoRoot 'Clipchamp_Bunny\tools\deploy-ledger.mjs'
$pkgJson    = Join-Path $RepoRoot 'package.json'
$fbiLogDir  = Join-Path $RepoRoot 'sarkari_deploy\records\fbi'
$fbiLogFile = Join-Path $fbiLogDir 'fbi-log.jsonl'

# What each banned runner looks like in the process table.
$cargoNameRe    = '(?i)^cargo(\.exe|\.cmd)?$'
$rustcNameRe    = '(?i)^rustc(\.exe)?$'
$rustdocNameRe  = '(?i)^rustdoc(\.exe)?$'
$linkNameRe     = '(?i)^(link|lld-link)(\.exe)?$'
$goNameRe       = '(?i)^go(\.exe)?$'
# tauri.js" build | tauri build | tauri dev (dev also compiles first).
$tauriCmdRe     = '(?i)\btauri(\.js)?["'']?\s+(build|dev)(\s|$|["''])'
# Frontend build lane: `npm run build`, `vite build`, `npx tauri ...`.
$frontBuildRe   = '(?i)\b(npm|pnpm|yarn)\b.*\brun\s+build\b|\bvite(\.js)?["'']?\s+build\b|\bnpx(\.cmd|\.exe)?\s+(tauri|vite)\b'
# cargo commands allowed locally: these never link.
$cargoOkSubs    = @('check', 'fmt', 'metadata', 'tree', '--version', '-V', '--help', '-h')
# go vet/test/fmt are allowed by AGENTS.md section 5; build/run are CI's work.
$goOkSubs       = @('vet', 'test', 'fmt', 'version')

function Trunc {
    param([string]$Text, [int]$Len = 96)
    if (-not $Text) { return '' }
    if ($Text.Length -le $Len) { return $Text }
    return $Text.Substring(0, $Len - 3) + '...'
}

function Find-CargoSub {
    # Extract the subcommand after a cargo token, tolerating quoted paths.
    param([string]$CommandLine)
    if (-not $CommandLine) { return 'unknown' }
    $stripped = ($CommandLine -replace '"[^"]*"', ' ') -replace "'[^']*'", ' '
    $tokens = @($stripped -split '\s+' | Where-Object { $_ })
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        if ($tokens[$i] -match $cargoNameRe) {
            if ($i + 1 -lt $tokens.Count) { return [string]$tokens[$i + 1].ToLowerInvariant() }
            return 'none'
        }
    }
    return 'unknown'
}

function Find-GoSub {
    param([string]$CommandLine)
    if (-not $CommandLine) { return 'unknown' }
    $stripped = ($CommandLine -replace '"[^"]*"', ' ') -replace "'[^']*'", ' '
    $tokens = @($stripped -split '\s+' | Where-Object { $_ })
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        if ($tokens[$i] -match $goNameRe) {
            if ($i + 1 -lt $tokens.Count) { return [string]$tokens[$i + 1].ToLowerInvariant() }
            return 'none'
        }
    }
    return 'unknown'
}

function Get-MemorySnapshot {
    # Free/total physical RAM, in MB. $null on failure (not worth stopping for).
    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        return @{
            FreeMB = [math]::Round(($os.FreePhysicalMemory * 1KB) / 1MB)
            TotalMB = [math]::Round(($os.TotalVisibleMemorySize * 1KB) / 1MB)
        }
    } catch {
        return @{ FreeMB = $null; TotalMB = $null }
    }
}

function Get-LocalWork {
    # Scan the live process table for compiling that slipped past the shim.
    # Returns { Reds, Yellows, Memory, ScanError }.
    $result = @{
        Reds      = @()
        Yellows   = @()
        Memory    = (Get-MemorySnapshot)
        ScanError = ''
    }

    # Never flag ourselves or our own ancestor chain.
    try {
        $selfList = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    } catch {
        $result.ScanError = $_.Exception.Message
        return $result
    }
    $byId = @{}
    foreach ($p in $selfList) { $byId[[int]$p.ProcessId] = $p }

    $selfChain = New-Object System.Collections.Generic.List[int]
    $cur = $PID
    for ($i = 0; $i -lt 8 -and $cur -gt 4; $i++) {
        if ($selfChain.Contains([int]$cur)) { break }
        $selfChain.Add([int]$cur)
        $me = $byId[[int]$cur]
        if (-not $me) { break }
        $cur = [int]$me.ParentProcessId
    }

    foreach ($p in $selfList) {
        if ($selfChain.Contains([int]$p.ProcessId)) { continue }
        $name = [string]$p.Name
        $cmd = [string]$p.CommandLine
        $ram = [math]::Round(([long]$p.WorkingSetSize) / 1MB)

        if ($name -match $cargoNameRe) {
            $sub = Find-CargoSub $cmd
            if ($cargoOkSubs -notcontains $sub) {
                $why = if ($sub -eq 'none' -or $sub -eq 'unknown') { "anjaan cargo command: '$sub'" }
                       else { "cargo $sub - ye compile karta hai" }
                $result.Reds += [pscustomobject]@{
                    Pid = [int]$p.ProcessId; Name = $name; Reason = $why
                    Evid = (Trunc $cmd); RamMB = $ram
                }
                continue
            }
        }

        if ($name -match $rustcNameRe) {
            # cargo check's rustc carries --emit=metadata; his father is the check.
            $parentCmd = ''
            $parent = $byId[[int]$p.ParentProcessId]
            if ($parent) { $parentCmd = [string]$parent.CommandLine }
            if (-not ($parentCmd -match '(?i)cargo(\.exe)?\s+check(\s|$)') -and
                -not ($cmd -match '(?i)--emit(=\s*|\s+)metadata(\s|$)')) {
                $result.Reds += [pscustomobject]@{
                    Pid = [int]$p.ProcessId; Name = $name; Reason = 'direct rustc compile (cargo check ka bacha nahi hai)'
                    Evid = (Trunc $cmd); RamMB = $ram
                }
            }
            continue
        }

        if ($name -match $rustdocNameRe) {
            $result.Reds += [pscustomobject]@{
                Pid = [int]$p.ProcessId; Name = $name; Reason = 'rustdoc - compile karta hai'
                Evid = (Trunc $cmd); RamMB = $ram
            }
            continue
        }

        if ($name -match $linkNameRe) {
            $parent = $byId[[int]$p.ParentProcessId]
            $parentName = if ($parent) { [string]$parent.Name } else { '' }
            $parentCmd = if ($parent) { [string]$parent.CommandLine } else { '' }
            if ($parentName -match '(?i)^rust(c|doc)(\.exe)?$' -or
                $parentName -match $cargoNameRe -or
                $cmd -match '(?i)src-tauri'
            ) {
                $result.Reds += [pscustomobject]@{
                    Pid = [int]$p.ProcessId; Name = $name; Reason = 'Rust linker - isi ki wajah se is box par RAM khatam ho jata hai'
                    Evid = (Trunc $cmd); RamMB = $ram
                }
            }
            continue
        }

        if ($cmd -and $cmd -match $tauriCmdRe) {
            $result.Reds += [pscustomobject]@{
                Pid = [int]$p.ProcessId; Name = $name; Reason = 'tauri build/dev - poora Rust compile is window ke peeche chal raha hai'
                Evid = (Trunc $cmd); RamMB = $ram
            }
            continue
        }

        # Yellow class - heavy-ish, but not an instant compile.
        if ($name -match $goNameRe) {
            $sub = Find-GoSub $cmd
            if ($goOkSubs -notcontains $sub) {
                $result.Yellows += [pscustomobject]@{
                    Pid = [int]$p.ProcessId; Name = $name
                    Reason = "go $sub - CI yeh free me bana dega (AGENTS.md 10)"
                    Evid = (Trunc $cmd); RamMB = $ram
                }
            }
            continue
        }
        if ($cmd -and $cmd -match $frontBuildRe) {
            $result.Yellows += [pscustomobject]@{
                Pid = [int]$p.ProcessId; Name = $name
                Reason = 'frontend build - CI dist bake karta hai, is machine par nahi'
                Evid = (Trunc $cmd); RamMB = $ram
            }
            continue
        }
    }

    # An open escape hatch is itself a red, process or no process.
    if ($env:T9_ALLOW_LOCAL_RUST) {
        $result.Reds += [pscustomobject]@{
            Pid = 0; Name = '<environment>'
            Reason = ('T9_ALLOW_LOCAL_RUST = {0} - shim ka talab khula hai (is shell me)' -f $env:T9_ALLOW_LOCAL_RUST)
            Evid = 'Abhi jo bhi cargo build chalega, real compile ban jayega'; RamMB = 0
        }
    }

    return $result
}

function Get-HatchScopes {
    # Where T9_ALLOW_LOCAL_RUST is set: Process / User / Machine.
    $scopes = @()
    if ($env:T9_ALLOW_LOCAL_RUST) { $scopes += 'Process' }
    try {
        if ([Environment]::GetEnvironmentVariable('T9_ALLOW_LOCAL_RUST', 'User')) { $scopes += 'User' }
        if ([Environment]::GetEnvironmentVariable('T9_ALLOW_LOCAL_RUST', 'Machine')) { $scopes += 'Machine' }
    } catch { }
    return $scopes
}

function Get-WorkflowInventory {
    # Every workflow file in .github/workflows - the multi CI/CD census.
    param([string]$Root)
    $dir = Join-Path $Root '.github\workflows'
    $items = @()
    if (Test-Path $dir) {
        foreach ($f in @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue)) {
            if ($f.Extension -notmatch '(?i)^\.ya?ml$') { continue }
            $head = @(Get-Content -LiteralPath $f.FullName -TotalCount 40 -ErrorAction SilentlyContinue) -join "`n"
            $m = [regex]::Match($head, '(?m)^\s*name:\s*(.+)$')
            $name = if ($m.Success) { $m.Groups[1].Value.Trim() } else { $f.BaseName }
            $items += [pscustomobject]@{
                File      = $f.Name
                Name      = $name
                Publisher = ($head -match '(?i)ci-latest')
            }
        }
    }
    return $items
}

function Get-RepoSlug {
    # owner/repo from the origin remote, whatever its URL shape.
    try {
        $url = (& git -C $RepoRoot remote get-url origin 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $url -match '(?i)[:/]([^/:]+?)/([^/]+?)(\.git)?/?$') {
            return ($Matches[1] + '/' + $Matches[2])
        }
    } catch { }
    return ''
}

function Get-CiRuns {
    # Last runs per workflow. Token optional: without it, return empty with a
    # reason so the report can point at the GitHub MCP instead.
    param([string]$RepoSlug)
    $tok = $env:GITHUB_TOKEN
    if (-not $tok -and $env:GH_TOKEN) { $tok = $env:GH_TOKEN }
    if (-not $RepoSlug) { return @{ OK = $false; Reason = 'origin remote padhi nahi gayi'; Runs = @() } }
    if (-not $tok)      { return @{ OK = $false; Reason = 'GITHUB_TOKEN/GH_TOKEN is shell me nahi hai'; Runs = @() } }
    try {
        $h = @{ 'Authorization' = "Bearer $tok"; 'User-Agent' = 'sarkari-fbi' }
        $resp = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoSlug/actions/runs?per_page=20" `
            -Headers $h -TimeoutSec 20 -ErrorAction Stop
        $runs = @($resp.workflow_runs)
        return @{ OK = $true; Reason = ''; Runs = $runs }
    } catch {
        return @{ OK = $false; Reason = $_.Exception.Message; Runs = @() }
    }
}

function Get-TargetActivity {
    # Release-folder / dist writes are local-build evidence; CI never writes
    # to this machine's tree. $null timestamps do not report.
    $hits = @()
    $candidates = @(
        @{ Path = (Join-Path $RepoRoot 'Clipchamp_Bunny\src-tauri\target\release'); Label = 'Rust release folder' },
        @{ Path = (Join-Path $RepoRoot 'src-tauri\target\release');                 Label = 'Rust release folder (alt root)' },
        @{ Path = (Join-Path $RepoRoot 'Clipchamp_Bunny\dist');                     Label = 'frontend dist' }
    )
    foreach ($c in $candidates) {
        if (-not (Test-Path $c.Path)) { continue }
        try {
            $newest = Get-ChildItem -LiteralPath $c.Path -Recurse -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($newest -and ((Get-Date) - $newest.LastWriteTime).TotalMinutes -lt 15) {
                $ageMin = [math]::Round(((Get-Date) - $newest.LastWriteTime).TotalMinutes, 1)
                $hits += ('{0}: {1} ({2} min pehle)' -f $c.Label, $newest.Name, $ageMin)
            }
        } catch { }
    }
    return $hits
}

function Write-FirLog {
    param([string]$Mode, [string]$Verdict, [hashtable]$Detail)
    # Append one JSON line per patrol/bust/doctor. Trim past 512 KB.
    try {
        if (-not (Test-Path $fbiLogDir)) {
            New-Item -ItemType Directory -Force -Path $fbiLogDir | Out-Null
        }
        $firNo = 1
        if (Test-Path $fbiLogFile) {
            $firNo = @(Get-Content -LiteralPath $fbiLogFile -ErrorAction SilentlyContinue).Count + 1
            if ((Get-Item -LiteralPath $fbiLogFile).Length -gt 524288) {
                $last = @(Get-Content -LiteralPath $fbiLogFile -Tail 200 -ErrorAction SilentlyContinue)
                Set-Content -LiteralPath $fbiLogFile -Value $last
                $firNo = 1
            }
        }
        $line = [ordered]@{
            timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
            firNo     = $firNo
            mode      = $Mode
            agent     = $Agent
            verdict   = $Verdict
            machine   = $env:COMPUTERNAME
            detail    = $Detail
        }
        Add-Content -LiteralPath $fbiLogFile -Value (($line | ConvertTo-Json -Depth 5 -Compress))
        return $firNo
    } catch {
        return 0
    }
}

# ------------------------------------------------------------------ modes ---

function Invoke-Patrol {
    # Scan live processes + local-build residue, log one FIR, teach briefly.
    $work = Get-LocalWork
    if ($work.ScanError) {
        Write-Json @{ mode = 'patrol'; verdict = 'scan_failed'; error = $work.ScanError; exit = 3 }
        if (-not $Json) {
            Write-Host 'FBI: process table padhi nahi gayi - scan adhura hai.' -ForegroundColor Red
            Write-Host ('  Reason: {0}' -f $work.ScanError) -ForegroundColor DarkGray
        }
        return 3
    }

    $workId = @($work.Reds | Where-Object { $_.Pid -gt 0 })
    $verdict = if (@($work.Reds).Count -gt 0) { 'violations' } else { 'clean' }
    $targetHits = @(Get-TargetActivity)
    if ($targetHits.Count -gt 0 -and $verdict -eq 'clean') { $verdict = 'suspect' }

    $logDetail = @{
        reds    = @($work.Reds | ForEach-Object { '{0}(pid {1}): {2}' -f $_.Name, $_.Pid, $_.Reason })
        yellows = @($work.Yellows | ForEach-Object { '{0}(pid {1}): {2}' -f $_.Name, $_.Pid, $_.Reason })
        target  = $targetHits
        freeRamMB = $work.Memory.FreeMB
    }
    $firNo = Write-FirLog 'patrol' $verdict $logDetail

    if ($Json) {
        Write-Json @{
            mode      = 'patrol'
            firNo     = $firNo
            machine   = $env:COMPUTERNAME
            freeRamMB = $work.Memory.FreeMB
            reds      = $work.Reds
            yellows   = $work.Yellows
            targetHits = $targetHits
            verdict   = $verdict
            exit      = 1
        }
        return 1
    }

    Write-Host ''
    Write-Host '========================================================' -ForegroundColor Cyan
    Write-Host '  SARKARI FBI - ANTI-LOCAL-COMPILE PATROL' -ForegroundColor Cyan
    Write-Host '========================================================' -ForegroundColor Cyan
    Write-Host ('  FIR #{0} | Agent: {1} | Machine: {2}' -f $firNo, $Agent, $env:COMPUTERNAME) -ForegroundColor Gray
    if ($work.Memory.FreeMB -ne $null) {
        Write-Host ('  Free RAM: {0} MB / {1} MB - isi wajah se heavy kaam ka yaha jagah nahi.' -f $work.Memory.FreeMB, $work.Memory.TotalMB) -ForegroundColor Gray
    }
    Write-Host ''

    foreach ($r in $work.Reds) {
        Write-Host ('[RED] {0} (pid {1}, RAM {2} MB)' -f $r.Name, $r.Pid, $r.RamMB) -ForegroundColor Red
        Write-Host ('      Kyun: {0}' -f $r.Reason) -ForegroundColor White
        Write-Host ('      Evidence: {0}' -f $r.Evid) -ForegroundColor DarkGray
    }
    foreach ($y in $work.Yellows) {
        Write-Host ('[YELLOW] {0} (pid {1})' -f $y.Name, $y.Pid) -ForegroundColor Yellow
        Write-Host ('         {0}' -f $y.Reason) -ForegroundColor DarkGray
        Write-Host ('         Evidence: {0}' -f $y.Evid) -ForegroundColor DarkGray
    }
    foreach ($t in $targetHits) {
        Write-Host ('[YELLOW] Build residue: {0}' -f $t) -ForegroundColor Yellow
    }

    if (@($work.Reds).Count -eq 0) {
        Write-Host '[GREEN] Koi local compile chal nahi raha. Yahi hi ideal hai.' -ForegroundColor Green
        if ($IncludeAllowed -and @($work.Yellows).Count -gt 0) {
            Write-Host '  (Yellow list upar dekho - bhaari hai par abhi kaatne layak nahi.)' -ForegroundColor DarkGray
        }
    }

    Write-ShortLesson
    if (@($work.Reds).Count -gt 0) {
        Write-Host 'ABHI KA KAM: ye compile is machine par roko -' -ForegroundColor Red
        Write-Host '  khud CTRL+C maro, ya mujhse: ' -ForegroundColor White
        Write-Host '  pwsh -File sarkari_deploy\sarkariFBI.ps1 -Bust -Yes' -ForegroundColor White
        Write-Host '  phir push karo aur CI se artifact install karvao (lesson niche).' -ForegroundColor White
        return 1
    }
    return 0
}

function Invoke-Bust {
    # Patrol, then kill the red processes (children were flagged first by scan order).
    $work = Get-LocalWork
    if ($work.ScanError) {
        if (-not $Json) { Write-Host ('FBI: scan adhura - {0}' -f $work.ScanError) -ForegroundColor Red }
        Write-Json @{ mode = 'bust'; verdict = 'scan_failed'; exit = 3; error = $work.ScanError }
        return 3
    }

    $targets = @($work.Reds | Where-Object { $_.Pid -gt 0 })
    $verdict = if ($targets.Count -gt 0) { 'violations' } else { 'clean' }
    Write-FirLog 'bust' $verdict @{
        reds        = @($work.Reds | ForEach-Object { '{0}(pid {1})' -f $_.Name, $_.Pid })
        killed      = @()
        freeRamMB   = $work.Memory.FreeMB
    } | Out-Null

    if ($Json) {
        Write-Json @{ mode = 'bust'; targets = $targets; verdict = $verdict; exit = $(if ($targets.Count) { 1 } else { 0 }) }
        return $(if ($targets.Count) { 1 } else { 0 })
    }

    if ($targets.Count -eq 0) {
        Write-Host 'FBI: koi compile process nahi mila - samjha diya kya? :)' -ForegroundColor Green
        if ($env:T9_ALLOW_LOCAL_RUST) {
            Write-Host 'Lekin T9_ALLOW_LOCAL_RUST khula hai - build agle round me slip kar sakta hai.' -ForegroundColor Yellow
        }
        return 0
    }

    Write-Host ''
    Write-Host 'SARKARI FBI - BUST EVIDENCE' -ForegroundColor Red
    foreach ($r in $targets) {
        Write-Host ('  pid {0}  {1}  {2} MB' -f $r.Pid, $r.Name, $r.RamMB) -ForegroundColor Red
        Write-Host ('      {0}' -f $r.Evid) -ForegroundColor DarkGray
    }

    if (-not $Yes) {
        $ans = Read-Host 'SAB KO MAAR DOON? (y/N)'
        if ($ans -notmatch '(?i)^y(es)?$') {
            Write-Host 'Bust cancel. Evidence FIR file me surakshit hai.' -ForegroundColor Gray
            return 0
        }
    }

    $killed = @()
    $failed = @()
    foreach ($r in $targets) {
        try {
            Stop-Process -Id $r.Pid -Force -ErrorAction Stop
            $killed += ('pid {0} ({1})' -f $r.Pid, $r.Name)
        } catch {
            $failed += ('pid {0} ({1}): {2}' -f $r.Pid, $r.Name, $_.Exception.Message)
        }
    }
    Write-Host ('Busted: {0}' -f ($killed -join '; ')) -ForegroundColor Green
    if ($failed.Count -gt 0) {
        Write-Host ('Nahi maara: {0}' -f ($failed -join '; ')) -ForegroundColor Yellow
    }
    $verdict2 = 'bust_done'
    Write-FirLog 'bust' $verdict2 @{ killed = $killed; failed = $failed } | Out-Null
    Write-ShortLesson
    return 1
}

function Add-Check {
    # Appends one guardrail result to $script:checks. It must run at script
    # scope: a function nested inside Invoke-Doctor cannot see that function's
    # local $checks, and a += there explodes (op_Addition on $null).
    param([string]$Name, [bool]$Okay, [string]$State, [string]$Detail)
    if (-not $State) { $State = if ($Okay) { 'OK' } else { 'RED' } }
    $script:checks += [pscustomobject]@{ Name = $Name; Okay = $Okay; State = $State; Detail = $Detail }
}

function Invoke-Doctor {
    # Are the guardrails really in place?
    $script:checks = @()

    # 1. The shim file itself.
    $shimExists = Test-Path $shimPath
    Add-Check 'cargo shim file' $shimExists $null `
        ($(if ($shimExists) { $shimPath } else { "missing: $shimPath - repair: New-Item -ItemType Directory -Force `"$env:USERPROFILE\.cargo-shim`"" }))

    # 2. PATH order: Get-Command cargo must resolve to the shim first.
    $resolvedOk = $false
    $resolvedDetail = 'cargo command nahi mili - shim PATH me sabse aage hona chahiye'
    try {
        $resolved = Get-Command cargo -ErrorAction SilentlyContinue
        if ($resolved) {
            $resolvedOk = ($resolved.Source -ieq $shimPath)
            $resolvedDetail = if ($resolvedOk) { "PATH me shim pehle hai: $shimPath" }
                else { "PATH cargo ko SHIM SE PEHLE dekh raha hai: $($resolved.Source) - User PATH me shim jod" }
        }
    } catch { }
    Add-Check 'PATH shim-first order' $resolvedOk $null $resolvedDetail

    # 3. Fire test - the cheap way that cannot start a compile even if broken.
    #    `cargo build --version` parses into an argument error on the real
    #    cargo, so the only harmless outputs are the shim's own refusal.
    $shimText = ''
    if ($shimExists) {
        try { $shimText = (Get-Content -LiteralPath $shimPath -Raw -ErrorAction Stop) } catch { }
    }
    $refusedOk = $false
    $refusedDetail = 'shim missing - fire test skip (upar RED dekho)'
    if ($shimExists -and ($shimText -match 'NOT ALLOWED')) {
        $savedHatch = $env:T9_ALLOW_LOCAL_RUST
        if ($savedHatch) { Remove-Item Env:T9_ALLOW_LOCAL_RUST -ErrorAction SilentlyContinue }
        try {
            $out = (cmd /c "`"$shimPath`" build --version" 2>&1 | Out-String)
            $refusedOk = ($LASTEXITCODE -ne 0) -and ($out -match 'NOT ALLOWED')
            $refusedDetail = if ($refusedOk) {
                "'cargo build' ke jawab me shim bola: RUST COMPILE IS NOT ALLOWED ON THIS MACHINE"
            } else {
                "shim ne refuse Nahi kiya! exit=$LASTEXITCODE output: $(Trunc ($out.Trim() -replace "`r|`n", ' ')) 120)"
            }
        } catch {
            $refusedDetail = "fire test fail: $($_.Exception.Message)"
        } finally {
            if ($savedHatch) { $env:T9_ALLOW_LOCAL_RUST = $savedHatch }
        }
    }
    Add-Check 'shim refuses (live fire test)' $refusedOk $null $refusedDetail

    # 4. The escape hatch - process, User and Machine scope.
    $hatch = @(Get-HatchScopes)
    Add-Check 'T9_ALLOW_LOCAL_RUST closed' ($hatch.Count -eq 0) $null `
        ($(if ($hatch.Count -eq 0) { 'tino scope me band hai (sahi)' }
            else { "khula: $($hatch -join ', ') - unset karo; ye sirf likha-gya deliberate try ke liye hai" }))

    # 5. Multi CI/CD inventory.
    $wf = @(Get-WorkflowInventory $RepoRoot)
    $hasCi = @($wf | Where-Object { $_.File -eq 'ci.yml' }).Count -gt 0
    $hasArti = @($wf | Where-Object { $_.File -eq 'sarkari-artifact.yml' }).Count -gt 0
    Add-Check 'multi CI/CD workflows' ($hasCi -and $hasArti) $null `
        ($(if ($hasCi -and $hasArti) { "ci.yml (gate/frontend/rust/go/installer) + sarkari-artifact.yml + $(@($wf).Count - 2) aur(ye bhi)" }
            else { "workflows mile: $($wf.File -join ', ') - ci.yml/sarkari-artifact.yml missing" }))

    # 6. The deploy door.
    $deployOk = Test-Path $deployPs1
    Add-Check 'deploy.ps1 (install door)' $deployOk $null `
        ($(if ($deployOk) { $deployPs1 } else { "missing: $deployPs1" }))

    # 7. The ledger CLI the queue runs on.
    Add-Check 'deploy-ledger.mjs (SQLite queue)' (Test-Path $ledgerMjs) $null `
        ($(if (Test-Path $ledgerMjs) { $ledgerMjs } else { "missing: $ledgerMjs" }))

    # 8. The cheap local gate exists in package.json scripts.
    $verifyOk = $false
    $verifyDetail = "missing: $pkgJson"
    if (Test-Path $pkgJson) {
        try {
            $pkg = Get-Content -LiteralPath $pkgJson -Raw -ErrorAction Stop | ConvertFrom-Json
            $verifyOk = $pkg.scripts.'verify:fast' -ne $null
            $verifyDetail = if ($verifyOk) { 'npm run verify:fast - repo root (sirf sasta verify, no compile)' }
                else { 'package.json me verify:fast nahi hai' }
        } catch { $verifyDetail = "package.json padhi nahi gayi: $($_.Exception.Message)" }
    }
    Add-Check 'verify:fast (the only heavy local lane)' $verifyOk $null $verifyDetail

    # 9. Git repo context.
    $inRepo = $false
    try {
        & git -C $RepoRoot rev-parse --is-inside-work-tree 2>$null | Out-Null
        $inRepo = ($LASTEXITCODE -eq 0)
    } catch { }
    Add-Check 'git repo' $inRepo $null ($(if ($inRepo) { $RepoRoot } else { 'repo root ke bahar - push/deploy recipe ke liye idhar chalao' }))

    $broken = @($script:checks | Where-Object { -not $_.Okay })
    $verdict = if ($broken.Count -gt 0) { 'guard_broken' } else { 'guarded' }
    $firNo = Write-FirLog 'doctor' $verdict @{ broken = @($broken | ForEach-Object { $_.Name }); total = @($script:checks).Count }

    if ($Json) {
        Write-Json @{ mode = 'doctor'; firNo = $firNo; checks = $script:checks; verdict = $verdict; exit = $(if ($broken.Count) { 2 } else { 0 }) }
        return $(if ($broken.Count) { 2 } else { 0 })
    }

    Write-Host ''
    Write-Host '========================================================' -ForegroundColor Cyan
    Write-Host '  SARKARI FBI - GUARD DOCTOR' -ForegroundColor Cyan
    Write-Host '========================================================' -ForegroundColor Cyan
    Write-Host ('  FIR #{0} | Repo: {1}' -f $firNo, $RepoRoot) -ForegroundColor Gray
    Write-Host ''
    foreach ($c in $script:checks) {
        $color = if ($c.Okay) { 'Green' } elseif ($c.State -eq 'YELLOW') { 'Yellow' } else { 'Red' }
        Write-Host ('  [{0}] {1}' -f $c.State, $c.Name) -ForegroundColor $color
        Write-Host ('      {0}' -f $c.Detail) -ForegroundColor DarkGray
    }
    Write-Host ''
    if ($broken.Count -eq 0) {
        Write-Host 'GUARD: sab deeware khadi hain. Koi agent is machine par compile nahi kar sakta.' -ForegroundColor Green
    } else {
        Write-Host ('GUARD: {0} deewar tooti/malang - upar RED line ka FIX padho.' -f $broken.Count) -ForegroundColor Red
        Write-Host '  Ye machine par koi bhi cargo build kar sakta hai jab tak shim wapas khadi na ho.' -ForegroundColor Red
    }
    Write-Host ''
    return $(if ($broken.Count) { 2 } else { 0 })
}

function Invoke-CiStatus {
    # The multi CI/CD census: every workflow, and the latest runs of each.
    $slug = Get-RepoSlug
    $inv = @(Get-WorkflowInventory $RepoRoot)
    $runsInfo = Get-CiRuns $slug
    $latestByName = @{}
    if ($runsInfo.OK) {
        foreach ($r in $runsInfo.Runs) {
            $n = [string]$r.name
            if (-not $latestByName.ContainsKey($n)) { $latestByName[$n] = $r }
        }
    }
    $verdict = if ($runsInfo.OK) { 'ok' } else { 'token_missing' }
    $firNo = Write-FirLog 'ci' $verdict @{ slug = $slug; workflows = @($inv | ForEach-Object { $_.File }); runsRead = @($runsInfo.Runs).Count }

    if ($Json) {
        Write-Json @{
            mode      = 'ci'
            slug      = $slug
            firNo     = $firNo
            workflows = $inv
            latest    = @($latestByName.Values | ForEach-Object {
                    [ordered]@{
                        workflow   = [string]$_.name
                        status     = [string]$_.status
                        conclusion = [string]$_.conclusion
                        commit     = [string]$_.head_sha.Substring(0, 7)
                        startedAt  = [string]$_.created_at
                        url        = [string]$_.html_url
                    }
                })
            token     = $runsInfo.OK
            tokenNote = $runsInfo.Reason
            exit      = 0
        }
        return 0
    }

    Write-Host ''
    Write-Host '========================================================' -ForegroundColor Cyan
    Write-Host '  SARKARI FBI - MULTI CI/CD STATUS (MULTI CI/CD SUPPORT)' -ForegroundColor Cyan
    Write-Host '========================================================' -ForegroundColor Cyan
    Write-Host ('  FIR #{0} | repo: {1}' -f $firNo, ($(if ($slug) { $slug } else { '(origin padhi nahi gayi)' }))) -ForegroundColor Gray
    Write-Host ''
    if ($inv.Count -eq 0) {
        Write-Host '  .github/workflows me koi yml hi nahi - CI/CD gayab hai!' -ForegroundColor Red
    }
    foreach ($w in $inv) {
        $tag = if ($w.Publisher) { 'publishes installable artifact (ci-latest)' } else { 'checks lane' }
        Write-Host ('  - {0,-24} "{1}"  [{2}]' -f $w.File, $w.Name, $tag) -ForegroundColor Cyan
    }
    Write-Host ''
    if ($latestByName.Count -gt 0) {
        Write-Host '  Latest run per workflow (GitHub API):' -ForegroundColor Cyan
        foreach ($kv in $latestByName.GetEnumerator()) {
            $run = $kv.Value
            $cc = if ([string]$run.conclusion -eq 'failure') { 'Red' } else { 'Green' }
            Write-Host ('  - {0}: {1} [{2}] commit {3}' -f $kv.Key, $run.status, $run.conclusion, $run.head_sha.Substring(0, 7)) -ForegroundColor $cc
        }
        Write-Host ''
        Write-Host ('  Sab runs: https://github.com/{0}/actions  (ya opencode me GitHub MCP)' -f $slug) -ForegroundColor DarkGray
    } else {
        Write-Host ('  Run status ke liye: {0}' -f $runsInfo.Reason) -ForegroundColor Yellow
        Write-Host '  Fix hi hai: opencode Chat me GitHub MCP khula hota hai (har naye session me globally)' -ForegroundColor Yellow
        Write-Host '  Push karte hi CI chalega - uska result wahi se dekho. Aram se skip nahin.' -ForegroundColor Yellow
    }
    Write-Host ''
    return 0
}

function Write-ShortLesson {
    # The 4-line law, repeated at the end of a patrol so the message sticks.
    Write-Host ''
    Write-Host '  FBI KA JHATKA (yaad hi rahega):' -ForegroundColor Gray
    Write-Host '  1. yaha sirf SASTA verify:  npm run verify:fast      (cargo check allowed hai)' -ForegroundColor Gray
    Write-Host '  2. compile GITHUB PE:       git add -A; git commit; git push' -ForegroundColor Gray
    Write-Host '  3. run CI me dekho:  opencode ka GitHub MCP (tools.github.*) ya web actions' -ForegroundColor Gray
    Write-Host '  4. install CI se:           pwsh -File Clipchamp_Bunny\tools\deploy.ps1 -Agent ... -Task ... -Why ... -Scope both' -ForegroundColor Gray
    Write-Host '  Details: pwsh -File sarkari_deploy\sarkariFBI.ps1 -Teach' -ForegroundColor DarkGray
}

function Invoke-Teach {
    # The full induction lecture. Cheap to run, zero side effects.
    $memory = Get-MemorySnapshot
    $firNo = Write-FirLog 'teach' 'lesson' @{ freeRamMB = $memory.FreeMB } | Out-Null

    if ($Json) {
        Write-Json @{ mode = 'teach'; firNo = $firNo; verdict = 'lesson'; exit = 0 }
        return 0
    }

    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Cyan
    Write-Host '     SARKARI FBI - NAYE AGENT KA INDUCTION LECTURE' -ForegroundColor Cyan
    Write-Host '============================================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  BHAI, PEHLI BAAT - YEH MACHINE KYA HAI' -ForegroundColor Yellow
    if ($memory.FreeMB -ne $null) {
        Write-Host ('    Intel i3, 8 GB RAM, abhi free {0} MB / {1} MB. OS khud 80% kha chuka hai.' -f $memory.FreeMB, $memory.TotalMB) -ForegroundColor Gray
    } else {
        Write-Host '    Intel i3, 8 GB RAM (OS khud 80% kha chuka hai).' -ForegroundColor Gray
    }
    Write-Host '    Rust ka release build yaha 6 se 12 minute, do baar (pehli baar linker RAM me halaak ho jata hai -' -ForegroundColor Gray
    Write-Host '    "rustc exited 0xffffffff" - aur build-lock pakad ke sab agents rok deta hai).' -ForegroundColor Gray
    Write-Host '    Hum 5-7 agents saath mein chalate hain - iska matlab: yaha sabki saans rukti hai jab ek compile chalta hai.' -ForegroundColor Gray

    Write-Host ''
    Write-Host '  IS MACHINE PE KYA CHALEGA' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '    ALLOWED - sasta, jaldi khatam, RAM nahi khata:' -ForegroundColor Yellow
    Write-Host '      - "cargo check"  (sirf type-check, link nahi)' -ForegroundColor Gray
    Write-Host '      - "cargo fmt"  "cargo metadata"  "cargo tree"  "cargo --version"' -ForegroundColor Gray
    Write-Host '      - gofmt / go vet / go test' -ForegroundColor Gray
    Write-Host '      - npm run check | lint | test  (ya pehli baar me verify:fast)' -ForegroundColor Gray
    Write-Host ''

    Write-Host '    BANNED - KABHI IS MACHINE PE MAT CHALANA:' -ForegroundColor Yellow
    Write-Host '      - cargo build / test / bench / clippy / doc / run' -ForegroundColor Gray
    Write-Host '      - tauri build  ya  tauri dev  (dev bhi sabse pehle compile karta hai!)' -ForegroundColor Gray
    Write-Host '      - npm run build / vite build  (dist CI bake karta hai)' -ForegroundColor Gray
    Write-Host '      - saath me koi rustc / link.exe / lld-link.exe' -ForegroundColor Gray
    Write-Host '      - T9_ALLOW_LOCAL_RUST=1 export - ye talab sirf deliberate, likha-padha exception ke liye hai' -ForegroundColor Gray
    Write-Host ''

    Write-Host '  CI/CD BANDOBAST (multi CI/CD: ci.yml + sarkari-artifact.yml)' -ForegroundColor Yellow
    Write-Host '    .github/workflows/ci.yml' -ForegroundColor Gray
    Write-Host '      - gate Â| frontend (svelte-check/docs) Â| rust (fmt + clippy + test)' -ForegroundColor Gray
    Write-Host '      - Go daemon (gofmt + vet + test) Â| Build Windows installer - artifact:T9EditorLIT-windows' -ForegroundColor Gray
    Write-Host '    .github/workflows/sarkari-artifact.yml' -ForegroundColor Gray
    Write-Host '      - ek hi kaam: installable artifact banana - queue chalata hai (cancel nahi karta, 7 agents ke push zinda rehte hain)' -ForegroundColor Gray
    Write-Host '      - rolling `ci-latest` release + `ci-<sha>` release, sarkari-manifest.json ke SHA-256 ke saath' -ForegroundColor Gray
    Write-Host '    (do lane = ek check karta hai, ek bechta hai: kaam dheema nahi hota chahe 7 agent push karein.)' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  PUSH-TO-SHIP RECIPE (repo root se, 4 step):' -ForegroundColor Yellow
    Write-Host '    # 1 - sirf sasta verify (YEH idhar hi allowed kaam hai):' -ForegroundColor Gray
    Write-Host '    npm run verify:fast' -ForegroundColor White
    Write-Host '    # 2 - push. Compile GitHub PE hota hai, tere browser/rustc se yaha kyu?' -ForegroundColor Gray
    Write-Host '    git add -A; git commit -m "kya aur kyu"; git push' -ForegroundColor White
    Write-Host '    # 3 - run CHECK: opencode CHAT me GitHub MCP (tools.github.*) ya web pe actions' -ForegroundColor Gray
    Write-Host '    # 4 - jis commit ka build aaya, wahi INSTALL karvao deploy.ps1 (ledger queue):' -ForegroundColor Gray
    Write-Host '    pwsh -File Clipchamp_Bunny\tools\deploy.ps1 \' -ForegroundColor White
    Write-Host '        -Agent "opencode/<tum>" -Model "<provider/model>" \' -ForegroundColor White
    Write-Host '        -Task "kya kiya" -Why "kyun zaroori" -EtaMinutes 10 -Scope both' -ForegroundColor White
    Write-Host '    (purana -Ci switch ab khaali hai - sarkari engine hamesha CI-artifact install karta hai)' -ForegroundColor DarkGray
    Write-Host '    (-ExpectCommit <sha> se apne commit ka build hi install hota hai)' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  FBI KE MODES (is file ke)' -ForegroundColor Yellow
    Write-Host '    (default)             - PATROL: abhi ka compile scan + FIR log' -ForegroundColor Gray
    Write-Host '    -Doctor               - guardrails ka x-ray (shim / PATH / hatch / workflows / deploy)' -ForegroundColor Gray
    Write-Host '    -Ci                   - multi CI/CD status: workflows + live runs' -ForegroundColor Gray
    Write-Host '    -Bust [-Yes]          - chal raha compile FORCE-KILL (8 GB box par legal hai)' -ForegroundColor Gray
    Write-Host '    -Teach                - yahi lecture (naya agent aaye to isse bula lena)' -ForegroundColor Gray
    Write-Host '    -Json                 - machine-readable jawab (exit 0/1/2/3)' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  EXIT CODES: 0 clean Â| 1 RED violation (compile chal raha) Â| 2 guard broken Â| 3 scan fail' -ForegroundColor DarkGray
    Write-Host '  FIR log: sarkari_deploy\records\fbi\fbi-log.jsonl' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  YAAD RAKHNE WALI EK HI LINE:' -ForegroundColor Green
    Write-Host '  verify idhar fast, Compile IDHAR NAHIN - push karo, CI banaata hai, deploy se install karwaao.' -ForegroundColor Green
    Write-Host ''
    return 0
}

function Write-Json {
    param([hashtable]$Body)
    $Body | ConvertTo-Json -Depth 6 -Compress | Write-Host
}

# --------------------------------------------------------------------- main ---

$mode = 'patrol'
if ($Teach)  { $mode = 'teach'  }
elseif ($Doctor) { $mode = 'doctor' }
elseif ($Ci) { $mode = 'ci'     }
elseif ($Bust) { $mode = 'bust' }

$code = switch ($mode) {
    'teach'  { Invoke-Teach; break }
    'doctor' { Invoke-Doctor; break }
    'ci'     { Invoke-CiStatus; break }
    'bust'   { Invoke-Bust; break }
    default  { Invoke-Patrol; break }
}
exit $code
