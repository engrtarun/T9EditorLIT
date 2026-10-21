<#
.SYNOPSIS
    Read-only guard against Sarkari dot-source parameter clobbering.

.DESCRIPTION
    Dot-sourcing a .ps1 file executes its top-level param(...) block in the
    CALLER's scope. When sarkariDeploy.ps1 loads sarkariForm.ps1 or
    sarkariKaam.ps1 without forwarding values, those variables are silently
    reset to their defaults ('' / 50 / $false).

    This draft parses sarkariDeploy.ps1 with the PowerShell AST and checks
    every critical dot-source call site. It changes nothing and uses no
    network, no media and no Python.

    Exit codes:
      0 = every critical call site forwards its values
      1 = clobber risk found
      2 = deploy script missing or unparsable

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

$deployPath = Join-Path $RepoRoot 'sarkari_deploy\sarkariDeploy.ps1'
if (-not (Test-Path $deployPath)) {
    Write-Host "[x] sarkariDeploy.ps1 not found at: $deployPath" -ForegroundColor Red
    exit 2
}

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $deployPath,
    [ref]$tokens,
    [ref]$parseErrors
)

if ($parseErrors.Count -gt 0) {
    Write-Host '[x] sarkariDeploy.ps1 has parse errors:' -ForegroundColor Red
    foreach ($e in $parseErrors) { Write-Host "    $($e.Message)" -ForegroundColor Red }
    exit 2
}

# Which parameters must survive the dot-source for each critical module.
$critical = @{
    'sarkariForm.ps1' = @('-Agent', '-Task', '-Why', '-FormFile')
    'sarkariKaam.ps1' = @('-AgentProfile')
}
# The main pipeline also needs the install directory; the -Check path builds
# its own literal profile and only runs the fast lane.
$mainFlow = @{
    'sarkariKaam.ps1' = @('-InstallDir')
}

$dotCommands = $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.CommandAst] -and
        $node.InvocationOperator -eq [System.Management.Automation.Language.TokenKind]::Dot
    }, $true)

$findings = New-Object System.Collections.Generic.List[string]
$rows = New-Object System.Collections.Generic.List[object]

foreach ($cmd in $dotCommands) {
    $text = ($cmd.Extent.Text -replace '\s+', ' ').Trim()
    $module = $null
    foreach ($name in $critical.Keys) {
        if ($text -match [regex]::Escape($name)) { $module = $name; break }
    }
    if (-not $module) { continue }

    $required = @($critical[$module])
    if ($module -eq 'sarkariKaam.ps1' -and $text -notmatch 'CHECK-ONLY') {
        $required += $mainFlow[$module]
    }

    $missing = @($required | Where-Object { $text -notmatch [regex]::Escape($_) })
    if ($missing.Count -gt 0) {
        $findings.Add("line $($cmd.Extent.StartLineNumber): $module missing $($missing -join ', ')")
    }

    $rows.Add([pscustomobject]@{
            Line    = $cmd.Extent.StartLineNumber
            Module  = $module
            Status  = if ($missing.Count -gt 0) { 'FAIL' } else { 'PASS' }
            Missing = ($missing -join ', ')
        })
}

Write-Host ''
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host '  SARKARI DOT-SOURCE CLOBBER GUARD (read-only)' -ForegroundColor Cyan
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host "  File: $deployPath"
Write-Host ''

if ($rows.Count -eq 0) {
    Write-Host '  [i] No critical dot-source call sites found.' -ForegroundColor Yellow
}
else {
    foreach ($row in $rows) {
        $colour = if ($row.Status -eq 'PASS') { 'Green' } else { 'Red' }
        Write-Host ("  [{0}] line {1,4}  {2,-18} missing: {3}" -f $row.Status, $row.Line, $row.Module, $row.Missing) -ForegroundColor $colour
    }
}

Write-Host ''
if ($findings.Count -gt 0) {
    Write-Host '  [x] CLOBBER RISK DETECTED:' -ForegroundColor Red
    foreach ($f in $findings) { Write-Host "      - $f" -ForegroundColor Red }
    Write-Host ''
    Write-Host '  Fix: forward every critical value into the dot-source, e.g.' -ForegroundColor Yellow
    Write-Host '    . (Join-Path $SarkariDir ''sarkariForm.ps1'') -Agent $Agent -Task $Task -Why $Why -FormFile $FormFile' -ForegroundColor DarkGray
    exit 1
}

Write-Host '  [ok] Every critical dot-source forwards its values.' -ForegroundColor Green
Write-Host ''
exit 0
