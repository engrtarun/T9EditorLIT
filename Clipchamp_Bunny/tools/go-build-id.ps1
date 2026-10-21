# tools/go-build-id.ps1
#
# The Go daemon's version id, and the ONE place it is computed.
#
# Why this file exists at all: the daemon's version is not a counter, it is a
# hash of the Go sources. deploy.ps1 compares the installed daemon's version
# against that hash to decide whether the Go half of a work order actually
# shipped, and CI stamps the same id into the binary it builds. If the two
# computed it separately they would drift the first time one of them was
# edited, and a perfectly good CI-built daemon would look like a stale one.
#
# One implementation, two callers:
#   - deploy.ps1 dot-sources this file and calls Get-GoSourceBuildId
#   - CI runs it:  T9_GO_ROOT=go pwsh -File tools/go-build-id.ps1
#
# The algorithm, exactly as deploy.ps1 used to compute it inline:
#   for every *.go / go.mod / go.sum under the root, sorted by full path,
#   append "<relative path>:<sha256 of the file>\n"; then SHA-256 that text,
#   hex it, and take the first 16 characters after the "go-" prefix.
#
# Deliberately NOT using a param() block: deploy.ps1 dot-sources this file
# and already has a $GoRoot of its own, and a param block here would bind
# over it. The standalone path reads the root from the environment instead.

function Get-GoSourceBuildId {
    <#
    .SYNOPSIS
        "go-<16 hex>" - the id of a set of Go sources.
    .PARAMETER Root
        The directory holding the Go sources (the 'go' folder).
    #>
    param([Parameter(Mandatory)][string]$Root)

    if (-not (Test-Path -LiteralPath $Root)) { return $null }

    # Same file set as before: Go sources and the two module files. Build
    # outputs (go\bin\*.exe) are excluded, so compiling the daemon does not
    # change its own id.
    $files = @(
        Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -eq '.go' -or $_.Name -eq 'go.mod' -or $_.Name -eq 'go.sum' } |
            Sort-Object FullName
    )
    if ($files.Count -eq 0) { return $null }

    $builder = [System.Text.StringBuilder]::new()
    foreach ($file in $files) {
        # $Root must be the same string the file paths start with, or this
        # substring cuts the wrong number of characters. Resolve-Path gives
        # exactly that: an absolute path with no trailing separator.
        $relative = $file.FullName.Substring($Root.Length).Replace('\', '/')
        $sha = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        [void]$builder.Append($relative).Append(':').Append($sha).Append("`n")
    }

    $bytes = [Text.Encoding]::UTF8.GetBytes($builder.ToString())
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    return "go-$($hash.Substring(0, 16))"
}

# Standalone use (CI):  T9_GO_ROOT=go pwsh -File tools/go-build-id.ps1
# The dot-source guard keeps this from running when deploy.ps1 loads the file.
if ($MyInvocation.InvocationName -ne '.') {
    $root = $env:T9_GO_ROOT
    if (-not $root) {
        # This file lives in Clipchamp_Bunny\tools, so one level up is
        # Clipchamp_Bunny - which has no Go folder in it. The Go sources are
        # at the repository root, two levels up. Look in both places and take
        # the one that exists, instead of the one that is assumed: a wrong
        # guess here does not fail loudly, it hashes nothing and CI then
        # stamps an empty version into the daemon.
        $here = Split-Path -Parent $PSScriptRoot
        foreach ($candidate in @((Join-Path $here 'go'), (Join-Path (Split-Path -Parent $here) 'go'))) {
            if (Test-Path -LiteralPath $candidate) { $root = $candidate; break }
        }
    }
    if (-not $root) {
        Write-Error 'the Go sources could not be found - set T9_GO_ROOT to the go folder'
        exit 1
    }
    $resolved = Resolve-Path -LiteralPath $root -ErrorAction SilentlyContinue
    if (-not $resolved) {
        Write-Error "go root not found: $root"
        exit 1
    }
    Write-Output (Get-GoSourceBuildId -Root $resolved.Path)
}
