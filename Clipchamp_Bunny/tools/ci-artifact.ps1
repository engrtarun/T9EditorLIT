# tools/ci-artifact.ps1
#
# Fetch the binaries CI built, and prove they are the ones CI published.
#
# This file is shared by the two places that install a build:
#   - Clipchamp_Bunny\tools\deploy.ps1  (the classic path)
#   - sarkari_deploy\sarkariKaam.ps1     (the live path the deploy actually runs)
#
# Both dot-source it rather than keeping their own copy, because the two
# copies would drift and the drift would show up as "the CI binary does not
# match the manifest" - a failure that looks like a corrupt download and is
# really two versions of the same rule.
#
# The rule itself: a downloaded executable may only be installed if its
# SHA-256 equals the SHA-256 in the manifest that came with it. The channel
# and the file have to agree, or a truncated download or a stale asset gets
# installed and then reported as shipped.

function Get-SarkariCiProp {
    # A property getter that returns $null instead of throwing, so a manifest
    # that is missing a field produces a clear message rather than a
    # StrictMode error somewhere far away.
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Get-SarkariCiSha256([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-SarkariCiArtifact {
    <#
    .SYNOPSIS
        Download the app and daemon that CI built, verified against CI's manifest.
    .PARAMETER Repo
        owner/name. Left empty, it is read from the git remote.
    .PARAMETER Release
        The release tag to fetch. CI keeps a rolling one called ci-latest.
    .PARAMETER DestinationRoot
        Where the download is kept. Keyed by build id, so a repeat deploy of
        the same build does not pull it again.
    .PARAMETER WorkspaceRoot
        The repository root, used to find the git remote.
    .PARAMETER BaseUrl
        Override the download base. It exists so the whole fetch-and-verify
        path can be exercised against a local server instead of a real
        release - an unproven download path is exactly how a broken one
        reaches production. It also points at a self-hosted mirror.
    .PARAMETER Commit
        The commit whose artifact is wanted. The release tag becomes
        `ci-<short sha>`, and the manifest's own commit is checked against
        it - a release published under a commit's name must BE that
        commit's build.
    .PARAMETER AllowMissing
        Return $null instead of throwing when the release does not exist.
        The caller uses it to wait for CI rather than to fail.
    #>
    param(
        [string]$Repo = '',
        [string]$Release = 'ci-latest',
        [Parameter(Mandatory)][string]$DestinationRoot,
        [string]$WorkspaceRoot = '',
        [string]$BaseUrl = '',
        [string]$Commit = '',
        [switch]$AllowMissing
    )

    if (-not $Repo -and $WorkspaceRoot) {
        $remote = (& git -C $WorkspaceRoot remote get-url origin 2>$null | Select-Object -First 1)
        if ($remote -and $remote -match 'github\.com[:/](?<owner>[^/]+)/(?<name>[^/\.]+)') {
            $Repo = "$($Matches['owner'])/$($Matches['name'])"
        }
    }
    if (-not $Repo) { throw '-Ci needs a GitHub repository; pass -CiRepo owner/name' }

    # A commit's own artifact lives under its own name. The rolling release
    # is a pointer that moves - with several agents pushing, it moves a lot,
    # and an agent that pushed commit 1234 must not be handed commit 1235's
    # build just because it was published a minute earlier.
    #
    # Both spellings of the tag are tried. The short one is what the current
    # workflow publishes; the full one is what an older build published, and
    # a run that is in flight right now must still be findable. A tag format
    # that changes underneath a waiting agent is exactly the kind of thing
    # that turns into "it said it shipped and nothing changed".
    $tags = @()
    if ($Commit) {
        $short = $Commit
        if ($short.Length -gt 7) { $short = $short.Substring(0, 7) }
        $tags = @("ci-$short", "ci-$Commit")
    } else {
        $tags = @($Release)
    }

    $headers = @{ 'User-Agent' = 'T9EditorLIT-deploy' }
    # The repository is public, so the assets download without a token. A
    # private repository needs one, and it is optional here on purpose: a
    # missing token must not be the reason a build cannot be installed.
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

    New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
    $manifestName = 'sarkari-manifest.json'
    $probe = Join-Path $DestinationRoot $manifestName

    $base = $null
    foreach ($tag in $tags) {
        $candidate = if ($BaseUrl) { "$($BaseUrl.TrimEnd('/'))/$tag" } else { "https://github.com/$Repo/releases/download/$tag" }
        Write-Host "==> Fetching the CI manifest from $candidate/$manifestName" -ForegroundColor Cyan
        try {
            Invoke-WebRequest -Uri "$candidate/$manifestName" -OutFile $probe -Headers $headers -UseBasicParsing
            $base = $candidate
            break
        } catch {
            if ($AllowMissing) { continue }
            throw "could not download the CI manifest from $candidate/$manifestName - $($_.Exception.Message). Has CI published a '$tag' release yet?"
        }
    }
    if (-not $base) {
        if ($AllowMissing) { return $null }
        throw "could not download the CI manifest for commit $Commit from any of: $($tags -join ', ')"
    }

    $manifest = $null
    try { $manifest = (Get-Content -LiteralPath $probe -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { $manifest = $null }
    if (-not $manifest) {
        if ($AllowMissing) { return $null }
        throw "the CI manifest could not be read: $probe"
    }

    # The release is named after a commit, so the artifact under that name
    # must be that commit's build. A mismatch means the release is stale or
    # was replaced, and installing it would put somebody else's work on the
    # user's desktop while claiming to be this agent's.
    $publishedCommit = [string](Get-SarkariCiProp $manifest 'gitCommit')
    if ($Commit -and $publishedCommit -and -not $publishedCommit.StartsWith($Commit.Substring(0, [Math]::Min(7, $Commit.Length)))) {
        throw "the release '$tag' holds the build of commit $publishedCommit, not $Commit - refusing to install it"
    }

    $buildId = [string](Get-SarkariCiProp $manifest 'buildId')
    if (-not $buildId) { throw "the CI manifest has no buildId: $probe" }

    # Keep the download under the build id so two builds never share a folder
    # and a repeat deploy of the same build reuses what is already here.
    $dir = Join-Path $DestinationRoot $buildId
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $manifestPath = Join-Path $dir $manifestName
    Move-Item -LiteralPath $probe -Destination $manifestPath -Force

    $app = Get-SarkariCiProp $manifest 'app'
    $appAsset = [string](Get-SarkariCiProp $app 'asset')
    $appSha = [string](Get-SarkariCiProp $app 'sha256')
    if (-not $appAsset -or -not $appSha) {
        throw "the CI manifest does not describe the app executable: $manifestPath"
    }

    $daemon = Get-SarkariCiProp $manifest 'daemon'
    $daemonAsset = [string](Get-SarkariCiProp $daemon 'asset')
    $daemonSha = [string](Get-SarkariCiProp $daemon 'sha256')
    $daemonVersion = [string](Get-SarkariCiProp $daemon 'version')
    $goSourceId = [string](Get-SarkariCiProp $manifest 'goSourceId')

    $exePath = Join-Path $dir $appAsset
    if (-not (Test-Path -LiteralPath $exePath)) {
        Write-Host "==> Downloading $appAsset" -ForegroundColor Cyan
        Invoke-WebRequest -Uri "$base/$appAsset" -OutFile $exePath -Headers $headers -UseBasicParsing
    }
    $actual = Get-SarkariCiSha256 $exePath
    if ($actual -ne $appSha) {
        throw "the CI executable does not match the manifest ($actual != $appSha); refusing to install it"
    }
    Write-Host "    [ok] CI executable verified ($appSha)" -ForegroundColor Green

    $daemonPath = $null
    if ($daemonAsset -and $daemonSha) {
        $daemonPath = Join-Path $dir $daemonAsset
        if (-not (Test-Path -LiteralPath $daemonPath)) {
            Write-Host "==> Downloading $daemonAsset" -ForegroundColor Cyan
            Invoke-WebRequest -Uri "$base/$daemonAsset" -OutFile $daemonPath -Headers $headers -UseBasicParsing
        }
        $daemonActual = Get-SarkariCiSha256 $daemonPath
        if ($daemonActual -ne $daemonSha) {
            throw "the CI daemon does not match the manifest ($daemonActual != $daemonSha); refusing to install it"
        }
        Write-Host "    [ok] CI daemon verified ($daemonSha)" -ForegroundColor Green
    }

    return [pscustomobject]@{
        ManifestPath  = $manifestPath
        Manifest      = $manifest
        BuildId       = $buildId
        ExePath       = $exePath
        ExeSha        = $appSha
        DaemonPath    = $daemonPath
        DaemonSha     = $daemonSha
        DaemonVersion = $daemonVersion
        GoSourceId    = $goSourceId
        GitCommit     = [string](Get-SarkariCiProp $manifest 'gitCommit')
        RunUrl        = [string](Get-SarkariCiProp $manifest 'ciRunUrl')
    }
}
