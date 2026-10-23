<#
.SYNOPSIS
    Sarkari Sahayak - the free-tier AI tutor of the sarkari family.

.DESCRIPTION
    Agents aur user ka madadgar: "yeh sawal" -> ek jawab (Hinglish),
    poore repo-kanoo ke upar, free-tier Puter model pe.

    Ye SIRF READ-ONLY salahkar hai - koi command nahi chalata, koi deploy
    nahi karta (Constitution KAANOON 1). AI chalana iska hissa hai, par
    AI band ho (no token / no consent / -NoAi / netwark nahi) to bhi kaam
    karta hai - local synopses + lesson hi jawab de deta hai (no magajmari).

    Payelin list (ek hi Brain engine, ek hi log, ek hi kanoon):

      sarkariDeploy: sawal
        -> AGENTS.md ka digest + sarkari family ke synopses + (maangna ho to)
           error tail ka last 120 lines
        -> constitution.md (KAANOON) + prompts/help.md (persona)
        -> Invoke-SarkariChat (redact, cap 24 KB, retry, ai-log)
        -> jawab print (ya -Json me ek line)

    Setup kya chahiye pehle:  pwsh -File sarkari_deploy\sarkariPuterjs.ps1 -Login
    Bina AI ka poora kaam:    ... -NoAi

.PARAMETER Query
    (chithi me Pehla param) tumhara sawal, e.g. "CI fail - kahan kah dekho?".

.PARAMETER ErrorText
    Kisi error/log file ka path (tail 120 lines uthaya jata hai) YA seedha
    raw error text. Alias: -Error. Secrets Brain redact kar deta hai.

.PARAMETER Lesson
    Naya agent? Induction print karo (bina AI - local hi).

.PARAMETER NoAi
    AI OFF - sirf local knowledge jawab (synopses + pointers).

.PARAMETER Model
    Free model override (e.g. sarkariPuterjs.ps1 -ListModels se nikala id).

.PARAMETER Persona
    prompts\<name>.md (default 'help'; baad me police/court/vakil/overseer).

.PARAMETER Agent
    Kis ne chalaya (ai-log me), e.g. 'opencode/beam-free'.

.PARAMETER TimeoutSec
    AI call ka timeout (default 90).

.PARAMETER Json
    Ek line me { ok, persona, model, latencyMs, answer|error, exit }.

.NOTES
    Exit codes: 0 jawab bana (AI OFF ho tab bhi 0, ok=false JSON me) -
    advisory tool hai, gate NAHI (gate ka kaam FBI/ledger karte hain).
    Log: sarkari_deploy\records\ai\ai-log.jsonl (metadata only).
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Query = '',
    [Parameter(Position = 1)]
    [Alias('Error')]
    [string]$ErrorText = '',
    [switch]$Lesson,
    [switch]$NoAi,
    [string]$Model = '',
    [string]$Persona = 'help',
    [string]$Agent = 'unknown',
    [ValidateRange(10, 600)]
    [int]$TimeoutSec = 90,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

. (Join-Path $PSScriptRoot 'sarkariBrain.ps1')
$cfg = Get-SarkariBrainConfig
$repoRoot = Resolve-SarkariRepoRoot

# ------------------------------------------------------------ context sevai ---

function Get-AgentsDigest {
    # AGENTS.md ka poora sach, par bina bhaarai me: chhota to poora MATLAB,
    # bada to header + khaas headings dekar (sections list) ke saath.
    $path = Join-Path $repoRoot 'AGENTS.md'
    if (-not (Test-Path $path)) { return '(AGENTS.md nahi mila - repo rule log missing?)' }
    try {
        $raw = (Get-Content -LiteralPath $path -Raw -ErrorAction Stop)
    } catch {
        return '(AGENTS.md padhi nahi gayi: ' + $_.Exception.Message + ')'
    }
    if ($raw.Length -le 9000) { return $raw }

    $head = $raw.Substring(0, 6000)
    $headings = @($raw -split "(`r`n|`n)" | Where-Object { $_ -match '^#{1,4} ' })
    $list = ($headings | Select-Object -First 60) -join "`n"
    $notice = "`n[Note: AGENTS.md lamba hai ({0} chars) - pehla hissa + saare headings bheje gaye hain.]`n"
    return ($head + ($notice -f $raw.Length) + "`n=== SECTION HEADINGS ===`n" + $list)
}

function Get-SarkariSynopses {
    # Har sarkari script ka .SYNOPSIS ki pehli line - family table.
    $lines = @()
    foreach ($f in @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.ps1' -ErrorAction SilentlyContinue)) {
        if ($f.Name -ieq 'sarkariBrain.ps1') { continue }  # engine module, pota chalne wala nahi
        $head = @(Get-Content -LiteralPath $f.FullName -TotalCount 60 -ErrorAction SilentlyContinue) -join "`n"
        $m = [regex]::Match($head, '(?m)^\s*\.SYNOPSIS\s*\r?\n\s*(.+?)\s*(\r?\n|$)')
        if ($m.Success) {
            $lines += ('{0,-22} {1}' -f $f.Name, $m.Groups[1].Value)
        } else {
            $lines += ('{0,-22} (synopsis nahi likhi)' -f $f.Name)
        }
    }
    return $lines
}

function Get-ErrorTail {
    # -ErrorText file path ho to tail 120 file ka, warna raw text.
    param([string]$Text)
    if (-not $Text) { return '' }
    if (Test-Path $Text -PathType Leaf) {
        try {
            $tail = @(Get-Content -LiteralPath $Text -Tail 120 -ErrorAction Stop) -join "`n"
            if ($tail.Length -gt 6000) { $tail = $tail.Substring($tail.Length - 6000) }
            return $tail
        } catch {
            return '(error file padhi nahi gayi: ' + $_.Exception.Message + ')'
        }
    }
    return $Text
}

# ------------------------------------------------------------ local fallback ---

function Show-SarkariHelp-Lesson {
    # Naya agent ka induction - AI ke bina, local hi. FBI -Teach ka jhatka
    # + AI layer ka setup. FIR log: nahi (lesson repeat hai, har baar).
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Cyan
    Write-Host '     SARKARI SAHAYAK - HELP TUTOR KA INDUCTION' -ForegroundColor Cyan
    Write-Host '============================================================' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  YEH MACHINE 8 GB i3 hai - heavy kaam yahin NAHIN hota:' -ForegroundColor Yellow
    Write-Host '    verify FAST idhar   : npm run verify:fast      (cargo check allowed)' -ForegroundColor Gray
    Write-Host '    compile GITHUB PE   : git commit + push       (CI/CD)' -ForegroundColor Gray
    Write-Host '    install CI SE       : pwsh -File Clipchamp_Bunny\tools\deploy.ps1 ...' -ForegroundColor Gray
    Write-Host '    FBI ka poora lecture: pwsh -File sarkari_deploy\sarkariFBI.ps1 -Teach' -ForegroundColor White
    Write-Host ''
    Write-Host '  AI LAYER (Puter free tier) ka setup + use:' -ForegroundColor Yellow
    Write-Host '    1) Login ek dafa : pwsh -File sarkari_deploy\sarkariPuterjs.ps1 -Login' -ForegroundColor Gray
    Write-Host '    2) Status        : pwsh -File sarkari_deploy\sarkariPuterjs.ps1 -Status' -ForegroundColor Gray
    Write-Host '    3) tumhara tutor : pwsh -File sarkari_deploy\sarkariHelp.ps1 "sawal"' -ForegroundColor White
    Write-Host '    4) Models dekho  : pwsh -File sarkari_deploy\sarkariPuterjs.ps1 -ListModels' -ForegroundColor Gray
    Write-Host '    5) AI band rakho : ... -NoAi   (sab local hi kaam karta rahega)' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  Kaise chalta hai (honest):' -ForegroundColor Yellow
    Write-Host '    - AI call me repo ka THODA text Puter cloud pe jata hai (tumhari' -ForegroundColor Gray
    Write-Host '      apni Puter account, free tier) - consent ek dafa le li jati hai.' -ForegroundColor Gray
    Write-Host '    - Secrets REDACT hoti (ghp_/sk-/AKIA/password=...)' -ForegroundColor Gray
    Write-Host '      aur token DPAPI file me hota hai (repo/.env me KABHI nahi).' -ForegroundColor Gray
    Write-Host '    - ai-log.jsonl me sirf METADATA (kab/persona/latency), text nahi.' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  Aage ka AI rishtey (aadmi/agent faide):' -ForegroundColor Yellow
    Write-Host '    - Court -Draft / Vakil -Draft (Phase 2) - drafts, approval tumhari' -ForegroundColor DarkGray
    Write-Host '    - sarkariOverseer.ps1 (Phase 3) - supervisors ka digest' -ForegroundColor DarkGray
    Write-Host ''
    return 0
}

function Show-SarkariLocalFallback {
    # Bina AI ka jawab: family table + key commands. Error ho to bhi print.
    Write-Host ''
    Write-Host '  AI IS BAAR NAHI THA - local knowledge ye rakho:' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  SARKARI FAMILY:' -ForegroundColor Cyan
    foreach ($l in (Get-SarkariSynopses)) { Write-Host ('    ' + $l) -ForegroundColor Gray }
    Write-Host ''
    Write-Host '  Jaldi wale commands:' -ForegroundColor Cyan
    Write-Host '    deploy status : pwsh -File Clipchamp_Bunny\tools\deploy.ps1 -Status' -ForegroundColor Gray
    Write-Host '    FBI doctor    : pwsh -File sarkari_deploy\sarkariFBI.ps1 -Doctor' -ForegroundColor Gray
    Write-Host '    FBI CI status : pwsh -File sarkari_deploy\sarkariFBI.ps1 -Ci' -ForegroundColor Gray
    Write-Host '    poori class   : pwsh -File sarkari_deploy\sarkariHelp.ps1 -Lesson' -ForegroundColor Gray
    if ($ErrorText) {
        Write-Host ''
        Write-Host '  (Tumne error diya tha, par AI band tha - file padhne ka surprise: AI ON karke)' -ForegroundColor DarkGray
        Write-Host '   phir se chalao: sarkariHelp.ps1 "yeh error" -Error <file>' -ForegroundColor DarkGray
    }
    Write-Host ''
}

function Invoke-Help {
    $digest = (Get-AgentsDigest) + "`n`n=== SARKARI SCRIPTS (family) ===`n" + ((Get-SarkariSynopses) -join "`n")
    $err = Get-ErrorTail $ErrorText
    if ($err) { $digest = $digest + "`n`n=== ERROR TAIL (user ne di) ===`n" + $err }

    $r = Invoke-SarkariChat -UserText $Query -ContextText $digest `
        -PersonaName $Persona -Model $Model -NoAi:$NoAi -TimeoutSec $TimeoutSec -Agent $Agent

    if ($r.Ok) {
        if ($Json) {
            Write-Host ([ordered]@{
                mode = 'help_query'; ok = $true; persona = $Persona
                model = $r.Model; latencyMs = $r.LatencyMs
                answer = $r.Content; exit = 0
            } | ConvertTo-Json -Depth 4 -Compress)
            return 0
        }
        Write-Host ''
        Write-Host ('SARKARI SAHAYAK (persona: {0}, model: {1}, {2} ms ke)' -f $Persona, $r.Model, $r.LatencyMs) -ForegroundColor Cyan
        Write-Host ('-' * 64) -ForegroundColor DarkGray
        Write-Host $r.Content
        Write-Host ('-' * 64) -ForegroundColor DarkGray
        return 0
    }

    # AI OFF/FAIL - advisory tool: local fallback de do, phir bhi 0.
    if ($Json) {
        Write-Host ([ordered]@{
            mode = 'help_query'; ok = $false; persona = $Persona
            error = $r.Error; short = $r.Short; exit = 0
        } | ConvertTo-Json -Depth 4 -Compress)
        return 0
    }
    Write-Host ''
    Write-Host ('  [YELLOW] {0}' -f $r.Short) -ForegroundColor Yellow
    Show-SarkariLocalFallback
    return 0
}

# --------------------------------------------------------------------- main ---

if ($Lesson) {
    $code = Show-SarkariHelp-Lesson
    exit $code
}
if (-not $Query) {
    # Bina sawal - apna hi help print: usage + family table (local, no AI).
    Write-Host ''
    Write-Host 'SARKARI SAHAYAK - AI tutor' -ForegroundColor Cyan
    Show-SarkariLocalFallback
    Write-Host ' Istemaal:' -ForegroundColor Cyan
    Write-Host '   pwsh -File sarkari_deploy\sarkariHelp.ps1 "kya sawal hai"' -ForegroundColor White
    Write-Host '   ...   -Error <log-path>      (error tail attach)' -ForegroundColor Gray
    Write-Host '   ...   -NoAi                  (AI off, local jawab)' -ForegroundColor Gray
    Write-Host '   ...   -Lesson                (naye agent ka induction)' -ForegroundColor Gray
    Write-Host '   ...   -Model <id>            (Puter -ListModels se nikle id)' -ForegroundColor Gray
    exit 0
}

$code = Invoke-Help
exit $code
