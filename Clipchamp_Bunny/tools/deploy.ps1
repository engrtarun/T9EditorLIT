<#
.SYNOPSIS
    The one door from source code to the installed desktop app + localhost daemon.

.DESCRIPTION
    A deploy is a work order, not a build command. Before anything is built,
    the ledger records:

      * who is deploying (agent name, model id, session)
      * what and why (task, reason)
      * how long they think it will take (ETA)
      * when they arrived, started and finished

    Then it serialises the queue (one active deploy), builds, installs the app,
    updates the t9cloud daemon, writes the build.json marker, verifies every
    hash, and closes the work order as `shipped`. The ledger is the only
    truthful status: "build is running" or "I will notify you later" is not a
    status.

    The update path is deliberately boring:

      - app not running  -> new exe is installed in place, taskbar opens it
      - app running      -> new exe is staged as t9-editor-lit.new.exe, the
                            app polls build.json and shows the Update button
      - daemon running   -> restarted immediately if the queue is idle, or
                            staged as t9cloud.new.exe when a job is in flight

    Every successful deploy writes evidence to
    %LOCALAPPDATA%\T9EditorLIT\deploy\evidence\<workId>.json and the SQLite
    ledger at %LOCALAPPDATA%\T9EditorLIT\deploy\ledger.db.

.PARAMETER Agent
    Who is deploying. Required unless T9_AGENT is set or -Interactive/-FormFile
    is used.

.PARAMETER Model
    Exact model id (for example opencode/deepseek-v4.1-flash-free). Required
    unless T9_MODEL / OPENCODE_MODEL / OPENCODE_MODEL_ID is set.

.PARAMETER Task
    Short description of the change (at least 8 characters).

.PARAMETER Why
    Why the change exists (at least 12 characters). "update" is not a reason.

.PARAMETER EtaMinutes
    Honest estimate for build + install + verify, excluding queue wait.

.PARAMETER Scope
    app, go, both or docs. `both` is the normal full desktop deploy.

.PARAMETER SkipBuild
    Reuse the newest build manifest. It is verified against its SHA-256 and
    refused if the manifest is from a different git commit (unless -Force).

.PARAMETER Interactive
    Ask the form questions in the terminal. Deploy.bat uses this.

.PARAMETER FormFile
    Read the form fields from a JSON file. See docs/AGENT_DEPLOY_PROTOCOL.md.

.PARAMETER Doctor
    Read-only health check of the installed app, marker, stage and daemon.

.PARAMETER Status
    Print the SQLite queue and recent work orders, then exit.

.EXAMPLE
    pwsh -File tools\deploy.ps1 -Interactive

.EXAMPLE
    pwsh -File tools\deploy.ps1 `
      -Agent "opencode" `
      -Model "opencode/deepseek-v4.1-flash-free" `
      -Task "fix the export button state" `
      -Why "the button stays disabled after a successful export" `
      -EtaMinutes 25 -Scope both

.EXAMPLE
    pwsh -File tools\deploy.ps1 -Status
    pwsh -File tools\deploy.ps1 -Doctor
#>
[CmdletBinding()]
param(
    [string]$Agent = $env:T9_AGENT,
    [string]$Model = $env:T9_MODEL,
    [string]$Session = $env:T9_SESSION,
    [string]$Task = $env:T9_TASK,
    [string]$Why = $env:T9_WHY,
    [int]$EtaMinutes = 0,
    [ValidateSet('app', 'go', 'both', 'docs')]
    [string]$Scope = 'app',
    [int]$Priority = 50,
    [switch]$Emergency,
    [switch]$SkipBuild,
    # -Ci takes the executable from CI instead of compiling it here.
    #
    # The reason is not fashion. This machine is an i3 with 8 GB of RAM that
    # is already ~96% used, and a Tauri release build on it dies in the
    # linker (rustc exits 0xffffffff) or takes twelve minutes while holding
    # the build lock that every other agent is waiting for. GitHub's Windows
    # runner has 7 GB and its own CPU, so the compile happens there and this
    # machine only verifies hashes and installs - which is the difference
    # between a twelve-minute build and a one-minute install.
    #
    # The contract does not change: same ledger, same build lock, same canary,
    # same marker, same doctor. Only the compiler moves.
    [switch]$Ci,
    [string]$CiRelease = 'ci-latest',
    [string]$CiRepo = '',
    [string]$CiBaseUrl = '',
    [switch]$SkipPin,
    [switch]$Launch,
    [switch]$Interactive,
    [switch]$NoWait,
    [int]$MaxWaitMinutes = 0,
    [string]$FormFile = '',
    [string]$BuildManifest = '',
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\T9EditorLIT'),
    [switch]$Doctor,
    [switch]$Status,
    [switch]$Json,
    [switch]$Force,
    # Declared here even though the Sarkari engine owns them. PowerShell
    # binds -File arguments against THIS param block before line 143 runs, so
    # without these two the documented `pwsh -File tools\deploy.ps1 -Check`
    # died with "A parameter cannot be found" and never reached the engine.
    # -Legacy also makes the opt-out below reachable instead of dead code.
    [switch]$Check,
    [switch]$Legacy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --------------------------------------------------------------------- paths
$AppDir = $PSScriptRoot | Split-Path -Parent
$RepoRoot = $AppDir | Split-Path -Parent
$ExeName = 't9-editor-lit.exe'
$DaemonName = 't9cloud.exe'
$InstallExe = Join-Path $InstallDir $ExeName
$InstallMarker = Join-Path $InstallDir 'build.json'
$StageExe = Join-Path $InstallDir 't9-editor-lit.new.exe'
$StageDaemon = Join-Path $InstallDir 't9cloud.new.exe'
$LedgerScript = Join-Path $PSScriptRoot 'deploy-ledger.mjs'
$BuildScript = Join-Path $PSScriptRoot 'build.ps1'
$PinScript = Join-Path $PSScriptRoot 'pin-taskbar.ps1'
$GoRoot = Join-Path $RepoRoot 'go'

# The daemon's version id is a hash of the Go sources, and it has to be
# computed identically here and in CI - otherwise a daemon built by CI looks
# like a different daemon to the check below, and the deploy refuses to call
# itself shipped. One implementation, two callers: this file and the workflow.
. (Join-Path $PSScriptRoot 'go-build-id.ps1')
$DefaultBuildDir = Join-Path $AppDir 'src-tauri\target'

if ($env:LOCALAPPDATA) {
    $DeployDir = Join-Path $env:LOCALAPPDATA 'T9EditorLIT\deploy'
} else {
    $DeployDir = Join-Path $RepoRoot '.t9\deploy'
}
$BuildDir = Join-Path $DeployDir 'builds'
$LogDir = Join-Path $DeployDir 'logs'
$EvidenceDir = Join-Path $DeployDir 'evidence'
$LockPath = Join-Path $DeployDir 'deploy.lock'
$LedgerDb = if ($env:T9_LEDGER_DB) { [IO.Path]::GetFullPath($env:T9_LEDGER_DB) } else { Join-Path $DeployDir 'ledger.db' }
$env:T9_LEDGER_DB = $LedgerDb
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# -------------------------------------------------------- sarkari bridge
$SarkariDeploy = Join-Path $RepoRoot 'sarkari_deploy\sarkariDeploy.ps1'
if ((-not $PSBoundParameters.ContainsKey('Legacy')) -and (Test-Path $SarkariDeploy)) {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $SarkariDeploy @PSBoundParameters
    exit $LASTEXITCODE
}

$script:WorkId = $null
$script:WorkToken = $null
$script:RunId = $null
$script:Finished = $false
# The daemon version this work order INTENDED to install. It is set when the
# daemon is chosen (a CI artifact, or a local build) and checked at the finish
# gate, so "shipped" can never be reported for a daemon that was not
# installed. Before this existed, two runs in a row reported SHIPPED with
# t9cloud.exe untouched, because nothing compared the two.
$script:IntendedDaemonVersion = $null
$script:CiArtifact = $null
$script:ExitCode = 0
$script:HeartbeatProcess = $null
$script:DeployLock = $null
$script:TranscriptStarted = $false
$script:EvidencePath = $null
$buildId = ''

# --------------------------------------------------------------------- node
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw 'Node.js is required (node:sqlite). Install Node 22.5+ and retry.'
}
$Node = $nodeCommand.Source
$nodeVersion = (& $Node -p 'process.versions.node' 2>$null | Out-String).Trim()
try {
    if ([version]$nodeVersion -lt [version]'22.5.0') {
        throw "Node $nodeVersion is too old"
    }
} catch {
    throw "could not read the Node version (got '$nodeVersion'); Node 22.5+ is required"
}
if (-not (Test-Path $LedgerScript)) {
    throw "the ledger script is missing: $LedgerScript"
}
if (-not (Test-Path $BuildScript)) {
    throw "the build script is missing: $BuildScript"
}

# ------------------------------------------------------------------ helpers
function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "    [ok] $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "    [!]  $Message" -ForegroundColor Yellow }
function Write-Bad([string]$Message) { Write-Host "    [x]  $Message" -ForegroundColor Red }
function Write-Dim([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }

function Initialize-DeployDirs {
    foreach ($dir in @($DeployDir, $BuildDir, $LogDir, $EvidenceDir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
}

# ConvertFrom-Json turns every ISO-8601 string into a [datetime]. Casting that
# to [string] yields the current culture ("10/20/2026 16:08:31"), which is not
# a timestamp the marker or Rust code should carry. Put the round-trip form
# back whenever a value is known to be a date.
function ConvertTo-IsoText {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [datetime]) { return $Value.ToUniversalTime().ToString('o') }
    return [string]$Value
}

function Get-Prop {
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

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try {
        return (Get-Content -Path $Path -Raw -ErrorAction Stop | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-Sha256([string]$Path) {
    if (-not $Path -or -not (Test-Path $Path)) { return $null }
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# The CI artifact downloader lives in tools/ci-artifact.ps1 and is shared with
# sarkari_deploy\sarkariKaam.ps1, which is the path the deploy actually runs. Two
# copies of the download-and-verify rule would drift, and the drift would look
# like a corrupt download.
. (Join-Path $PSScriptRoot 'ci-artifact.ps1')

function Invoke-Ledger {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & $Node --no-warnings $LedgerScript @Arguments 2>&1
    $code = $LASTEXITCODE
    $text = ($output | Out-String).Trim()
    if ($code -ne 0) {
        throw "deploy ledger '$($Arguments[0])' failed (exit $code): $text"
    }
    if (-not $text) { return $null }
    try {
        return $text | ConvertFrom-Json
    } catch {
        throw "deploy ledger returned unreadable JSON: $text"
    }
}

function Invoke-LedgerHuman {
    param([Parameter(Mandatory)][string[]]$Arguments)
    & $Node --no-warnings $LedgerScript @Arguments
    return $LASTEXITCODE
}

function Get-GitText([string[]]$GitArgs) {
    try {
        $value = & git -C $RepoRoot @GitArgs 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return (($value | Out-String).Trim())
    } catch {
        return $null
    }
}

function Get-ProcessPath([int]$ProcessId) {
    try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        if ($cim -and $cim.ExecutablePath) { return $cim.ExecutablePath }
    } catch {
        # the process may have exited
    }
    try {
        return (Get-Process -Id $ProcessId -ErrorAction Stop).Path
    } catch {
        return $null
    }
}

function Get-ProcessesByName([string]$Name) {
    $result = @()
    foreach ($proc in @(Get-Process -Name $Name -ErrorAction SilentlyContinue)) {
        $path = $null
        try { $path = $proc.Path } catch { $path = Get-ProcessPath $proc.Id }
        if (-not $path) { $path = Get-ProcessPath $proc.Id }
        $result += [pscustomobject]@{ Id = $proc.Id; Path = $path }
    }
    return $result
}

function Test-PathInDir([string]$Path, [string]$Dir) {
    if (-not $Path -or -not $Dir) { return $false }
    try {
        $full = [IO.Path]::GetFullPath($Path)
        $dirFull = [IO.Path]::GetFullPath($Dir).TrimEnd('\') + '\'
        return $full.StartsWith($dirFull, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Get-AppProcesses { return @(Get-ProcessesByName 't9-editor-lit') }
function Get-DaemonProcesses { return @(Get-ProcessesByName 't9cloud') }

function Get-DaemonHealth {
    try {
        return Invoke-RestMethod -Uri 'http://127.0.0.1:7878/healthz' -TimeoutSec 3 -ErrorAction Stop
    } catch {
        return $null
    }
}

function Wait-DaemonHealth([string]$ExpectedVersion = '', [int]$TimeoutSeconds = 20) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $health = Get-DaemonHealth
        if ($health) {
            $version = [string](Get-Prop $health 'version')
            if (-not $ExpectedVersion -or $version -eq $ExpectedVersion) { return $health }
        }
        Start-Sleep -Milliseconds 500
    }
    return (Get-DaemonHealth)
}

function Get-DaemonVersion([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try {
        $output = & $Path -version 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $text = ($output | Out-String).Trim()
        if (-not $text) { return $null }
        $parts = $text -split '\s+'
        return $parts[-1]
    } catch {
        return $null
    }
}

function Stop-Processes([object[]]$Processes) {
    foreach ($proc in @($Processes)) {
        if (-not $proc) { continue }
        try {
            Stop-Process -Id $proc.Id -Force -ErrorAction Stop
            Write-Dim "stopped pid $($proc.Id) $($proc.Path)"
        } catch {
            Write-Warn "could not stop pid $($proc.Id): $($_.Exception.Message)"
        }
    }
}

function Close-ForeignApps([object[]]$Processes) {
    $items = @($Processes)
    if ($items.Count -eq 0) { return }
    foreach ($proc in $items) {
        Write-Warn "closing non-installed app pid $($proc.Id): $($proc.Path)"
        try {
            $live = Get-Process -Id $proc.Id -ErrorAction Stop
            [void]$live.CloseMainWindow()
        } catch {
            # already gone
        }
    }
    Start-Sleep -Seconds 4
    foreach ($proc in $items) {
        if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction Stop
            } catch {
                throw "could not close pid $($proc.Id); close it manually and run deploy again"
            }
        }
    }
}

function Prepare-AppProcesses {
    $all = @(Get-AppProcesses)
    $foreign = @($all | Where-Object { -not (Test-PathInDir $_.Path $InstallDir) })
    if ($foreign.Count -gt 0) {
        Write-Step 'Closing app instances that do not come from the install folder'
        Close-ForeignApps $foreign
    }
    $all = @(Get-AppProcesses)
    $foreign = @($all | Where-Object { -not (Test-PathInDir $_.Path $InstallDir) })
    if ($foreign.Count -gt 0) {
        throw 'a non-installed app is still running; close it and retry (the taskbar app is the only supported entry point)'
    }
    $installed = @($all | Where-Object { Test-PathInDir $_.Path $InstallDir })
    return [pscustomobject]@{ Running = ($installed.Count -gt 0); Processes = $installed }
}

function Wait-FileLock([string]$Path, [int]$TimeoutSeconds = 1200) {
    $start = Get-Date
    $waited = 0
    while ($true) {
        try {
            return [IO.File]::Open(
                $Path,
                [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::None
            )
        } catch {
            if (((Get-Date) - $start).TotalSeconds -ge $TimeoutSeconds) {
                throw "timed out waiting for the deploy lock: $Path"
            }
            if ($waited % 20 -eq 0) {
                Write-Dim "waiting for the deploy lock ($waited s)"
            }
            Start-Sleep -Seconds 2
            $waited += 2
        }
    }
}

function Get-GoBuildId {
    # The algorithm itself lives in tools/go-build-id.ps1 so that CI computes
    # the very same id. A second copy of it here would be one more thing to
    # keep in step, and "kept in step" is exactly what it would not be.
    if (-not (Test-Path $GoRoot)) { return $null }
    return Get-GoSourceBuildId -Root $GoRoot
}

function Resolve-BuildManifest([string]$Explicit, [string]$BuildId) {
    if ($BuildId) {
        $byId = Join-Path $BuildDir "$BuildId.json"
        if (Test-Path $byId) { return $byId }
    }
    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "build manifest not found: $Explicit" }
        return (Resolve-Path $Explicit).Path
    }
    $latest = Join-Path $BuildDir 'latest.json'
    if (Test-Path $latest) { return $latest }
    $fallback = Join-Path $DefaultBuildDir 'release\build-manifest.json'
    if (Test-Path $fallback) { return $fallback }
    return $null
}

function Sync-EnvFile {
    $source = Join-Path $RepoRoot '.env'
    $destination = Join-Path $InstallDir '.env'
    if (-not (Test-Path $source)) {
        if (-not (Test-Path $destination)) {
            Write-Warn 'no .env in the repository or install folder - cloud features stay offline'
        }
        return
    }
    $sourceSha = Get-Sha256 $source
    $destinationSha = Get-Sha256 $destination
    if ($destinationSha -eq $sourceSha) { return }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    if (Test-Path $destination) {
        Copy-Item $destination "$destination.bak" -Force
    }
    $temp = Join-Path $InstallDir '.env.tmp'
    Copy-Item $source $temp -Force
    if ((Get-Sha256 $temp) -ne $sourceSha) {
        Remove-Item $temp -Force -ErrorAction SilentlyContinue
        throw 'copied .env hash mismatch'
    }
    Move-Item $temp $destination -Force
    Write-Ok 'installed the repository .env (cloud keys and T9CLOUD_ADDR)'
}

function Start-InstalledDaemon {
    $exe = Join-Path $InstallDir $DaemonName
    if (-not (Test-Path $exe)) { return $null }
    $envFile = Join-Path $InstallDir '.env'
    $outLog = Join-Path $LogDir 't9cloud.out.log'
    $errLog = Join-Path $LogDir 't9cloud.err.log'
    try {
        if (Test-Path $envFile) {
            $argLine = "-env `"$envFile`""
            return Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory $InstallDir `
                -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
        }
        return Start-Process -FilePath $exe -WorkingDirectory $InstallDir `
            -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    } catch {
        Write-Warn "could not start the daemon: $($_.Exception.Message)"
        return $null
    }
}

function Write-BuildMarker {
    param(
        [string]$Mode,
        [string]$BuildId,
        [string]$BuiltAt,
        [string]$AppSha,
        [string]$DaemonBuildId,
        [string]$DaemonSha,
        [string]$DaemonVersion,
        [object]$Manifest
    )
    $now = (Get-Date).ToUniversalTime().ToString('o')
    $marker = [ordered]@{
        version        = '0.1.0'
        buildId        = $BuildId
        builtAt        = $BuiltAt
        installedAt    = $now
        stagedAt       = if ($Mode -eq 'staged') { $now } else { $null }
        mode           = $Mode
        gitCommit      = Get-Prop $Manifest 'gitCommit'
        gitDirty       = [bool](Get-Prop $Manifest 'gitDirty')
        workId         = $script:WorkId
        agent          = $Agent
        model          = $Model
        scope          = $Scope
        appSha256      = $AppSha
        daemonBuildId  = $DaemonBuildId
        daemonSha256   = $DaemonSha
        daemonVersion  = $DaemonVersion
        host           = $env:COMPUTERNAME
    }
    $json = $marker | ConvertTo-Json -Depth 6
    $temp = Join-Path $InstallDir '.build.json.tmp'
    [IO.File]::WriteAllText($temp, $json, $Utf8NoBom)
    Move-Item -Path $temp -Destination $InstallMarker -Force
    return [pscustomobject]$marker
}

function Install-App {
    param(
        [string]$SourceExe,
        [string]$Sha256,
        [string]$BuildId,
        [string]$BuiltAt,
        [object]$Manifest
    )
    Write-Step 'Installing the app'
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $temp = Join-Path $InstallDir ".t9-install-$BuildId.exe"
    Copy-Item -Path $SourceExe -Destination $temp -Force
    $tempSha = Get-Sha256 $temp
    if ($tempSha -ne $Sha256) {
        Remove-Item $temp -Force -ErrorAction SilentlyContinue
        throw "copied app hash mismatch: $tempSha != $Sha256"
    }

    $appProcs = @(Get-AppProcesses)
    $installed = @($appProcs | Where-Object { Test-PathInDir $_.Path $InstallDir })
    $foreign = @($appProcs | Where-Object { -not (Test-PathInDir $_.Path $InstallDir) })
    if ($foreign.Count -gt 0) {
        Close-ForeignApps $foreign
        $appProcs = @(Get-AppProcesses)
        $installed = @($appProcs | Where-Object { Test-PathInDir $_.Path $InstallDir })
        if (@($appProcs | Where-Object { -not (Test-PathInDir $_.Path $InstallDir) }).Count -gt 0) {
            throw 'a non-installed app is still running; close it and retry'
        }
    }

    if ($installed.Count -gt 0) {
        Write-Ok "the installed app is running (pid $($installed[0].Id)) - staging the new build"
        if (Test-Path $StageExe) { Remove-Item $StageExe -Force }
        Move-Item -Path $temp -Destination $StageExe -Force
        $stageSha = Get-Sha256 $StageExe
        if ($stageSha -ne $Sha256) {
            throw "staged app hash mismatch: $stageSha != $Sha256"
        }
        return [pscustomobject]@{
            Mode      = 'staged'
            LiveSha   = Get-Sha256 $InstallExe
            StagedSha = $stageSha
            Running   = $true
        }
    }

    Write-Ok 'the installed app is not running - installing the build directly'
    $old = Join-Path $InstallDir 't9-editor-lit.old.exe'
    if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
    $movedOld = $false
    try {
        if (Test-Path $InstallExe) {
            Move-Item -Path $InstallExe -Destination $old -Force
            $movedOld = $true
        }
        Move-Item -Path $temp -Destination $InstallExe -Force
    } catch {
        # The app may have started between the check and the move. Fall back
        # to staging rather than leaving a half-installed folder.
        Write-Warn "direct install failed ($($_.Exception.Message)); switching to stage mode"
        if ($movedOld -and (Test-Path $old) -and -not (Test-Path $InstallExe)) {
            Move-Item $old $InstallExe -Force
        }
        if (Test-Path $temp) {
            if (Test-Path $StageExe) { Remove-Item $StageExe -Force -ErrorAction SilentlyContinue }
            Move-Item $temp $StageExe -Force
        }
        $stageSha = Get-Sha256 $StageExe
        if ($stageSha -ne $Sha256) {
            throw 'could not install or stage the app'
        }
        return [pscustomobject]@{
            Mode      = 'staged'
            LiveSha   = Get-Sha256 $InstallExe
            StagedSha = $stageSha
            Running   = $true
        }
    }

    $liveSha = Get-Sha256 $InstallExe
    if ($liveSha -ne $Sha256) {
        if ($movedOld -and (Test-Path $old)) {
            Remove-Item $InstallExe -Force -ErrorAction SilentlyContinue
            Move-Item $old $InstallExe -Force
        }
        throw "installed app hash mismatch: $liveSha != $Sha256"
    }
    if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
    if (Test-Path $StageExe) {
        # A staged binary that survives a live install is a **downgrade trap**:
        # the app decides to show its Update button purely from the existence
        # of this file (see `installed_build` in src-tauri/src/lib.rs), and the
        # click would then install an OLDER build than the live one. Removing
        # it silently let that happen - the file stayed behind, the button
        # appeared, and the "update" rolled the app backwards. Fail loudly
        # instead: a leftover file is a problem worth stopping for.
        Remove-Item $StageExe -Force -ErrorAction SilentlyContinue
        if (Test-Path $StageExe) {
            throw "a stale staged build is still at $StageExe - remove it, or the Update button would install an older binary"
        }
    }
    return [pscustomobject]@{
        Mode      = 'installed'
        LiveSha   = $liveSha
        StagedSha = $null
        Running   = $false
    }
}

function Install-Daemon {
    param(
        [string]$Source,
        [string]$Sha,
        [string]$Version,
        [bool]$AppRunning,
        [bool]$Required
    )
    $live = Join-Path $InstallDir $DaemonName
    $stage = Join-Path $InstallDir 't9cloud.new.exe'
    $old = Join-Path $InstallDir 't9cloud.old.exe'
    $liveSha = Get-Sha256 $live
    $liveVersion = Get-DaemonVersion $live

    if (-not $Source -or -not (Test-Path $Source) -or -not $Sha -or -not $Version) {
        if (Test-Path $live) {
            Write-Warn "no fresh daemon binary; keeping the installed daemon ($liveVersion)"
            return [pscustomobject]@{
                Mode      = 'unchanged'
                Sha       = $liveSha
                Version   = $liveVersion
                Pending   = $false
            }
        }
        if ($Required) { throw 't9cloud daemon is missing and no fresh build was produced' }
        Write-Warn 't9cloud daemon is missing - cloud features stay offline'
        return [pscustomobject]@{ Mode = 'missing'; Sha = $null; Version = $null; Pending = $false }
    }

    $needsUpdate = -not (Test-Path $live) -or $liveSha -ne $Sha -or $liveVersion -ne $Version
    if (-not $needsUpdate) {
        if (Test-Path $stage) { Remove-Item $stage -Force -ErrorAction SilentlyContinue }
        $procs = @(Get-DaemonProcesses)
        if ($procs.Count -eq 0) {
            Write-Step 'Starting the t9cloud daemon'
            $null = Start-InstalledDaemon
            $health = Wait-DaemonHealth $Version 20
            if (-not $health) { throw 'the daemon did not answer /healthz after start' }
        }
        Write-Ok "daemon is already current ($Version)"
        return [pscustomobject]@{
            Mode      = 'unchanged'
            Sha       = $liveSha
            Version   = $Version
            Pending   = $false
        }
    }

    $health = Get-DaemonHealth
    $queue = Get-Prop $health 'queue'
    $inFlight = [int](Get-Prop $queue 'in_flight')
    if ($inFlight -gt 0 -and $AppRunning) {
        Write-Warn "daemon has $inFlight job(s) in flight - staging t9cloud.new.exe; the Update click will swap it"
        Copy-Item -Path $Source -Destination $stage -Force
        $stageSha = Get-Sha256 $stage
        if ($stageSha -ne $Sha) { throw "staged daemon hash mismatch: $stageSha != $Sha" }
        return [pscustomobject]@{
            Mode      = 'staged'
            Sha       = $stageSha
            Version   = $liveVersion
            Pending   = $true
        }
    }

    if ($inFlight -gt 0 -and -not $AppRunning) {
        Write-Warn "daemon has $inFlight job(s) in flight; waiting up to 90 s for the queue to drain"
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 5
            $health = Get-DaemonHealth
            $inFlight = [int](Get-Prop (Get-Prop $health 'queue') 'in_flight')
            if ($inFlight -le 0) { break }
        }
        if ($inFlight -gt 0) {
            throw "daemon still has $inFlight job(s) in flight; wait for them and run deploy again (nothing was killed)"
        }
    }

    $procs = @(Get-DaemonProcesses)
    if ($procs.Count -gt 0) {
        Write-Step "Restarting the t9cloud daemon ($liveVersion -> $Version)"
        Stop-Processes $procs
        Start-Sleep -Seconds 1
    }

    $temp = Join-Path $InstallDir ".t9-daemon-$Version.exe"
    Copy-Item -Path $Source -Destination $temp -Force
    $tempSha = Get-Sha256 $temp
    if ($tempSha -ne $Sha) { throw "copied daemon hash mismatch: $tempSha != $Sha" }
    if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
    $movedOld = $false
    try {
        if (Test-Path $live) {
            Move-Item $live $old -Force
            $movedOld = $true
        }
        Move-Item $temp $live -Force
    } catch {
        if ($movedOld -and (Test-Path $old) -and -not (Test-Path $live)) {
            Move-Item $old $live -Force
        }
        throw "could not install the daemon: $($_.Exception.Message)"
    }
    $newSha = Get-Sha256 $live
    if ($newSha -ne $Sha) {
        if ($movedOld -and (Test-Path $old)) {
            Remove-Item $live -Force -ErrorAction SilentlyContinue
            Move-Item $old $live -Force
        }
        throw "installed daemon hash mismatch: $newSha != $Sha"
    }
    if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }

    Write-Step 'Starting the t9cloud daemon'
    $null = Start-InstalledDaemon
    $health = Wait-DaemonHealth $Version 25
    if (-not $health) { throw 'the daemon did not answer /healthz after restart' }
    $actualVersion = [string](Get-Prop $health 'version')
    if ($actualVersion -ne $Version) {
        throw "daemon reports version '$actualVersion', expected '$Version'"
    }
    if (Test-Path $stage) { Remove-Item $stage -Force -ErrorAction SilentlyContinue }
    Write-Ok "daemon $Version is live at http://127.0.0.1:7878"
    return [pscustomobject]@{
        Mode      = 'restarted'
        Sha       = $Sha
        Version   = $Version
        Pending   = $false
    }
}

function Show-Doctor {
    Write-Step 'Deployment doctor'
    $ok = $true
    if (-not (Test-Path $InstallDir)) {
        Write-Bad "install folder missing: $InstallDir"
        return $false
    }
    $liveSha = Get-Sha256 $InstallExe
    $stageSha = Get-Sha256 $StageExe
    $marker = Read-JsonFile $InstallMarker
    $health = Get-DaemonHealth
    $appProcs = @(Get-AppProcesses)
    $foreign = @($appProcs | Where-Object { -not (Test-PathInDir $_.Path $InstallDir) })
    $installedProcs = @($appProcs | Where-Object { Test-PathInDir $_.Path $InstallDir })

    if (-not (Test-Path $InstallExe)) {
        Write-Bad "app missing: $InstallExe"
        $ok = $false
    } else {
        Write-Ok "app: $InstallExe"
        Write-Dim "sha256: $liveSha"
    }

    if (-not $marker) {
        Write-Bad "marker missing or unreadable: $InstallMarker"
        $ok = $false
    } else {
        $buildId = [string](Get-Prop $marker 'buildId')
        $mode = [string](Get-Prop $marker 'mode')
        $markerAppSha = [string](Get-Prop $marker 'appSha256')
        if (-not $buildId -or -not $mode) {
            Write-Bad 'marker predates the build ledger (no buildId/mode) - run a deploy'
            $ok = $false
        } else {
            Write-Ok "marker: build=$buildId mode=$mode"
        }
        if ($markerAppSha) {
            $actual = if ($stageSha) { $stageSha } else { $liveSha }
            if ($actual -ne $markerAppSha) {
                Write-Bad "app hash does not match marker ($actual != $markerAppSha)"
                $ok = $false
            } else {
                Write-Ok 'app hash matches the marker'
            }
        }
        $daemonExpected = [string](Get-Prop $marker 'daemonVersion')
        $daemonTarget = [string](Get-Prop $marker 'daemonBuildId')
        if ($health -and $daemonExpected) {
            $actualVersion = [string](Get-Prop $health 'version')
            if ($actualVersion -ne $daemonExpected) {
                Write-Bad "daemon version mismatch (live $actualVersion, marker $daemonExpected)"
                $ok = $false
            } else {
                Write-Ok "daemon live: $actualVersion"
            }
        } elseif ($health -and $daemonTarget) {
            Write-Dim "daemon live: $([string](Get-Prop $health 'version')) (target $daemonTarget)"
        } elseif ($daemonTarget) {
            Write-Bad "daemon is not running (expected $daemonTarget)"
            $ok = $false
        }
    }

    if ($stageSha) {
        # The app shows its Update button purely because this file exists, so a
        # staged binary that is OLDER than the live one is a trap: the click
        # installs an older build. The live install path removes the file, but
        # a deploy that staged earlier and was never applied can leave one
        # behind - the doctor is where that gets caught.
        $stagedAge = (Get-Item $StageExe).LastWriteTime
        $liveAge = if (Test-Path $InstallExe) { (Get-Item $InstallExe).LastWriteTime } else { [datetime]::MinValue }
        if ($liveAge -gt $stagedAge) {
            Write-Bad "staged app update is OLDER than the live app ($stagedAge < $liveAge) - the Update button would install an older binary"
            Write-Dim 'remove it with: Remove-Item -Force "' + $StageExe + '"'
            $ok = $false
        } else {
            Write-Warn "staged app update present: $StageExe"
            Write-Dim "sha256: $stageSha (the app should show Update within 5 s)"
        }
    } else {
        Write-Ok 'no staged app update'
    }
    if (Test-Path $StageDaemon) {
        Write-Warn "staged daemon update present: $StageDaemon"
    }
    if ($installedProcs.Count -gt 0) {
        Write-Ok "installed app is running (pid $($installedProcs[0].Id))"
    } else {
        Write-Warn 'installed app is not running'
    }
    if ($foreign.Count -gt 0) {
        Write-Bad "non-installed app instance(s): $(($foreign | ForEach-Object { "$($_.Id) $($_.Path)" }) -join '; ')"
        $ok = $false
    }
    if (-not $health) {
        Write-Warn 'daemon health endpoint is not reachable'
    }
    return $ok
}

function Stop-Heartbeat {
    if ($script:HeartbeatProcess) {
        try {
            if (-not $script:HeartbeatProcess.HasExited) {
                Stop-Process -Id $script:HeartbeatProcess.Id -Force -ErrorAction SilentlyContinue
            }
        } catch {
            # already gone
        }
        $script:HeartbeatProcess = $null
    }
}

function Close-WorkOrder {
    param(
        [string]$Outcome,
        [string]$ErrorText = '',
        [string]$Mode = '',
        [string]$BuildId = '',
        [string]$Evidence = ''
    )
    if (-not $script:WorkId -or -not $script:WorkToken -or $script:Finished) { return $null }
    $finishArgs = @(
        'finish', '--json',
        "--id=$($script:WorkId)",
        "--token=$($script:WorkToken)",
        "--outcome=$Outcome"
    )
    if ($Mode) { $finishArgs += "--mode=$Mode" }
    if ($BuildId) { $finishArgs += "--build-id=$BuildId" }
    if ($ErrorText) { $finishArgs += "--error=$ErrorText" }
    if ($Evidence) { $finishArgs += "--evidence=$Evidence" }
    try {
        $result = Invoke-Ledger $finishArgs
        $script:Finished = $true
        return $result
    } catch {
        Write-Warn "could not close the ledger work order: $($_.Exception.Message)"
        return $null
    }
}

function Close-Session {
    if (-not $Session) { return }
    try {
        $null = Invoke-Ledger @('session-end', '--json', "--session=$Session")
    } catch {
        Write-Warn "could not close the session record: $($_.Exception.Message)"
    }
}

function Write-EvidenceFile([object]$Evidence) {
    $path = Join-Path $EvidenceDir "$($script:WorkId).json"
    [IO.File]::WriteAllText($path, ($Evidence | ConvertTo-Json -Depth 12), $Utf8NoBom)
    return $path
}

function Print-Form {
    Write-Host ''
    Write-Host 'T9 deploy request - the form is part of the deploy.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  -Agent       who is deploying (your agent name)' -ForegroundColor Gray
    Write-Host '  -Model       exact model id (provider/model)' -ForegroundColor Gray
    Write-Host '  -Task        what changes (8+ characters)' -ForegroundColor Gray
    Write-Host '  -Why         why it matters (12+ characters)' -ForegroundColor Gray
    Write-Host '  -EtaMinutes  honest estimate for build+install+verify' -ForegroundColor Gray
    Write-Host '  -Scope       app | go | both | docs (default app)' -ForegroundColor Gray
    Write-Host '  -Priority    0..100 (default 50; >60 needs -Emergency)' -ForegroundColor Gray
    Write-Host '  -Ci          take the executable from CI instead of compiling here' -ForegroundColor Gray
    Write-Host '  -CiRelease   the CI release to install (default ci-latest)' -ForegroundColor Gray
    Write-Host ''
    Write-Host 'Example:' -ForegroundColor Yellow
    Write-Host '  pwsh -File tools\deploy.ps1 `' -ForegroundColor DarkGray
    Write-Host '    -Agent "opencode" `' -ForegroundColor DarkGray
    Write-Host '    -Model "opencode/deepseek-v4.1-flash-free" `' -ForegroundColor DarkGray
    Write-Host '    -Task "fix the export button state" `' -ForegroundColor DarkGray
    Write-Host '    -Why "the button stays disabled after a successful export" `' -ForegroundColor DarkGray
    Write-Host '    -EtaMinutes 25 -Scope both' -ForegroundColor DarkGray
    Write-Host ''
}

# ------------------------------------------------------------------- boot
Initialize-DeployDirs

if ($Status) {
    $statusArgs = @('status', "--db=$LedgerDb")
    if ($Json) { $statusArgs += '--json' }
    & $Node --no-warnings $LedgerScript @statusArgs
    exit $LASTEXITCODE
}

if ($Doctor) {
    if (Show-Doctor) { exit 0 }
    exit 1
}

# Guarantee the schema before the first request. This is also what makes a
# brand-new machine work without a separate setup step.
$null = Invoke-Ledger @('init', "--db=$LedgerDb")

# ------------------------------------------------------------------- form
if ($FormFile) {
    if (-not (Test-Path $FormFile)) { throw "form file not found: $FormFile" }
    $form = Read-JsonFile $FormFile
    if (-not $form) { throw "form file is not valid JSON: $FormFile" }
    if (-not $Agent) { $Agent = [string](Get-Prop $form 'agent') }
    if (-not $Model) { $Model = [string](Get-Prop $form 'model') }
    if (-not $Session) { $Session = [string](Get-Prop $form 'session') }
    if (-not $Task) { $Task = [string](Get-Prop $form 'task') }
    if (-not $Why) { $Why = [string](Get-Prop $form 'why') }
    if ($EtaMinutes -le 0) { $EtaMinutes = [int](Get-Prop $form 'etaMinutes') }
    if (-not $PSBoundParameters.ContainsKey('Scope') -and (Get-Prop $form 'scope')) {
        $Scope = [string](Get-Prop $form 'scope')
    }
    if (-not $PSBoundParameters.ContainsKey('Priority') -and (Get-Prop $form 'priority')) {
        $Priority = [int](Get-Prop $form 'priority')
    }
}

if (-not $Model) {
    foreach ($envName in @('T9_MODEL', 'OPENCODE_MODEL', 'OPENCODE_MODEL_ID')) {
        $value = [Environment]::GetEnvironmentVariable($envName)
        if ($value) { $Model = $value; break }
    }
}

if ($Interactive) {
    Write-Host ''
    Write-Host 'T9 deploy request' -ForegroundColor Cyan
    Write-Host 'Answer six questions. The ledger records them before any build.' -ForegroundColor DarkGray
    $answer = Read-Host "Agent name [$Agent]"
    if ($answer) { $Agent = $answer }
    $answer = Read-Host "Model id [$Model]"
    if ($answer) { $Model = $answer }
    $answer = Read-Host 'Task (what changes)'
    if ($answer) { $Task = $answer }
    $answer = Read-Host 'Why (why it matters)'
    if ($answer) { $Why = $answer }
    $answer = Read-Host "ETA in minutes [$([Math]::Max(10, $EtaMinutes))]"
    if ($answer) { $EtaMinutes = [int]$answer }
    $answer = Read-Host "Scope app|go|both|docs [$Scope]"
    if ($answer) { $Scope = $answer }
    $answer = Read-Host "Priority 0..100 [$Priority]"
    if ($answer) { $Priority = [int]$answer }
}

if (-not $Agent) { $Agent = '' }
if (-not $Model) { $Model = '' }
if (-not $Task) { $Task = '' }
if (-not $Why) { $Why = '' }

$Agent = $Agent.Trim()
$Model = $Model.Trim()
$Task = ($Task -replace '\s+', ' ').Trim()
$Why = ($Why -replace '\s+', ' ').Trim()
$Scope = if ($Scope) { $Scope.ToLowerInvariant() } else { 'app' }

# The ledger's schema caps `task` at 200 characters. An agent writing a
# natural-language task crosses that limit without meaning to, and the
# consequence is silent: deploy-ledger rejects the submit, no work order is
# issued, and the build then runs with no lease at all - which breaks the one
# rule this pipeline exists to keep, that the ledger is the truth. It happened
# on a real deploy that still reported SHIPPED afterwards. Clamp it here, while
# the value is still just text, so a work order always gets created. The full
# sentence cannot survive the cap, so say that out loud rather than quietly
# losing the tail of it.
if ($Task.Length -gt 200) {
    $Task = $Task.Substring(0, 197) + '...'
    Write-Warn 'Task was longer than the ledger allows (200 chars) and has been truncated; -Why carries the rest'
}
if ($Why.Length -gt 2000) { $Why = $Why.Substring(0, 1997) + '...' }

$missing = @()
if ($Agent.Length -lt 2) { $missing += 'Agent (2+ characters)' }
if ($Model.Length -lt 3) { $missing += 'Model (3+ characters)' }
if ($Task.Length -lt 8) { $missing += 'Task (8+ characters)' }
if ($Why.Length -lt 12) { $missing += 'Why (12+ characters)' }
if ($EtaMinutes -lt 1 -or $EtaMinutes -gt 480) { $missing += 'EtaMinutes (1..480)' }
if ($Scope -notin @('app', 'go', 'both', 'docs')) { $missing += 'Scope (app|go|both|docs)' }
if ($Priority -lt 0 -or $Priority -gt 100) { $missing += 'Priority (0..100)' }
if ($Priority -gt 60 -and -not $Emergency) { $missing += 'Priority above 60 needs -Emergency' }

if ($missing.Count -gt 0) {
    Print-Form
    Write-Bad "missing or invalid: $($missing -join ', ')"
    exit 2
}

if ($Emergency) { $Priority = [Math]::Max($Priority, 90) }
if (-not $Session) {
    $safeAgent = $Agent -replace '[^A-Za-z0-9._-]', '-'
    $Session = "S-$safeAgent-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'))"
}
if (-not $Session.ToLowerInvariant().StartsWith('s-')) { $Session = "S-$Session" }

$gitCommit = Get-GitText @('rev-parse', 'HEAD')
$gitShort = Get-GitText @('rev-parse', '--short', 'HEAD')
$gitBranch = Get-GitText @('rev-parse', '--abbrev-ref', 'HEAD')
$gitStatus = Get-GitText @('status', '--porcelain')
$gitDirty = [bool]($gitStatus -and $gitStatus.Length -gt 0)

Write-Host ''
Write-Host 'T9 deploy request' -ForegroundColor Cyan
Write-Host "  agent:   $Agent" -ForegroundColor Gray
Write-Host "  model:   $Model" -ForegroundColor Gray
Write-Host "  task:    $Task" -ForegroundColor Gray
Write-Host "  why:     $Why" -ForegroundColor Gray
Write-Host "  eta:     $EtaMinutes min" -ForegroundColor Gray
Write-Host "  scope:   $Scope" -ForegroundColor Gray
Write-Host "  session: $Session" -ForegroundColor DarkGray
Write-Host "  git:     $(if ($gitShort) { $gitShort } else { 'unknown' }) $(if ($gitDirty) { '(dirty)' } else { '' })" -ForegroundColor DarkGray

if ($Interactive) {
    $confirm = Read-Host 'Proceed? [Y/n]'
    if ($confirm -match '^[nN]') {
        Write-Host 'Cancelled before a work order was created.' -ForegroundColor Yellow
        exit 0
    }
}

$transcript = Join-Path $LogDir "deploy-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
try {
    Start-Transcript -Path $transcript -Append | Out-Null
    $script:TranscriptStarted = $true
} catch {
    Write-Warn "could not start the log transcript: $($_.Exception.Message)"
}

try {
    # ------------------------------------------------------------- request
    Write-Step 'Recording the work order'
    $requestArgs = @(
        'request', '--json',
        "--agent=$Agent",
        "--model=$Model",
        "--task=$Task",
        "--why=$Why",
        "--eta=$EtaMinutes",
        "--scope=$Scope",
        "--priority=$Priority",
        "--session=$Session",
        "--worktree=$AppDir",
        "--agent-pid=$PID"
    )
    if ($Emergency) { $requestArgs += '--emergency' }
    if ($gitCommit) { $requestArgs += "--commit=$gitCommit" }
    if ($gitBranch) { $requestArgs += "--branch=$gitBranch" }
    if ($gitDirty) { $requestArgs += '--git-dirty' }

    $request = Invoke-Ledger $requestArgs
    $script:WorkId = [string](Get-Prop $request 'workId')
    $script:WorkToken = [string](Get-Prop $request 'token')
    if (-not $script:WorkId -or -not $script:WorkToken) {
        throw 'the ledger did not return a work id and token'
    }
    $position = Get-Prop $request 'position'
    $queueDepth = Get-Prop $request 'queueDepth'
    $etaAhead = Get-Prop $request 'etaAheadMinutes'
    Write-Ok "work order $($script:WorkId) queued at position $position/$queueDepth"
    Write-Dim "estimated work ahead: $etaAhead min (your ETA: $EtaMinutes min)"
    if (@(Get-Prop $request 'expired').Count -gt 0) {
        Write-Warn "recovered $(@(Get-Prop $request 'expired').Count) stale work order(s) first"
    }

    # --------------------------------------------------------------- claim
    $leaseMinutes = [Math]::Max(10, [Math]::Min(90, $EtaMinutes + 15))
    $maxWait = if ($MaxWaitMinutes -gt 0) {
        $MaxWaitMinutes
    } else {
        [Math]::Max(10, [Math]::Min(180, $EtaMinutes + 30))
    }
    $waitStart = Get-Date
    $claim = $null
    while ($true) {
        $claim = Invoke-Ledger @(
            'claim', '--json',
            "--id=$($script:WorkId)",
            "--token=$($script:WorkToken)",
            "--lease-minutes=$leaseMinutes"
        )
        $state = [string](Get-Prop $claim 'state')
        if ($state -eq 'active') { break }
        if ($state -ne 'waiting') { throw "unexpected claim state: $state" }

        $active = Get-Prop $claim 'active'
        $position = Get-Prop $claim 'position'
        $queueDepth = Get-Prop $claim 'queueDepth'
        $etaAhead = Get-Prop $claim 'etaAheadMinutes'
        $line = "[queue] position $position/$queueDepth, about $etaAhead min of work ahead"
        if ($active) {
            $line += " | active: $([string](Get-Prop $active 'id')) $([string](Get-Prop $active 'agent')) / $([string](Get-Prop $active 'model')) - $([string](Get-Prop $active 'task'))"
        }
        Write-Host $line -ForegroundColor Yellow

        if ($NoWait) {
            $null = Close-WorkOrder -Outcome 'cancelled' -ErrorText 'queue busy and -NoWait was set'
            throw "queue is busy; work order $($script:WorkId) was cancelled (re-run without -NoWait to wait)"
        }
        $elapsed = ((Get-Date) - $waitStart).TotalMinutes
        if ($elapsed -gt $maxWait) {
            $null = Close-WorkOrder -Outcome 'cancelled' -ErrorText "queue wait exceeded $maxWait min"
            throw "queue wait exceeded $maxWait min; work order $($script:WorkId) was cancelled"
        }
        # claim() refreshes the queued heartbeat, so a long wait is not
        # mistaken for a vanished agent.
        Start-Sleep -Seconds (Get-Random -Minimum 8 -Maximum 14)
    }

    $script:RunId = [string](Get-Prop $claim 'runId')
    Write-Ok "work order is active (run $($script:RunId), lease $leaseMinutes min)"
    Write-Dim "arrived: $((Get-Date).ToString('HH:mm:ss'))  |  deploy lock: $LockPath"

    $script:DeployLock = Wait-FileLock $LockPath 1200
    Write-Ok 'deploy lock held (a second deploy cannot interleave the install)'

    # A separate Node process keeps the lease alive during a long cargo link.
    # It also exits by itself if this PowerShell process dies (--parent-pid).
    $heartbeatLine = "--no-warnings `"$LedgerScript`" heartbeat-loop --id=$($script:WorkId) --token=$($script:WorkToken) --interval=20 --lease-minutes=$leaseMinutes --phase=build --parent-pid=$PID"
    try {
        $script:HeartbeatProcess = Start-Process -FilePath $Node -ArgumentList $heartbeatLine -WindowStyle Hidden -PassThru
    } catch {
        Write-Warn "heartbeat loop did not start: $($_.Exception.Message)"
    }

    # --------------------------------------------------------------- build
    if ($Ci) {
        # The compile happened on GitHub's runner; this machine only fetches
        # the result and checks it. Everything after this point is the same
        # pipeline a local build goes through - same ledger, same install, same
        # canary - so switching compilers changes the cost, not the contract.
        Write-Step 'Taking the executable from CI (-Ci)'
        $ciDir = Join-Path $BuildDir 'ci'
        $script:CiArtifact = Get-SarkariCiArtifact -Repo $CiRepo -Release $CiRelease -DestinationRoot $ciDir -WorkspaceRoot $RepoRoot -BaseUrl $CiBaseUrl
        $buildId = $script:CiArtifact.BuildId
        $builtExe = $script:CiArtifact.ExePath
        $builtSha = $script:CiArtifact.ExeSha
        $builtAt = ConvertTo-IsoText (Get-Prop $script:CiArtifact.Manifest 'builtAt')
        $manifestPath = $script:CiArtifact.ManifestPath
        $manifest = $script:CiArtifact.Manifest
        if ($script:CiArtifact.RunUrl) { Write-Ok "CI run: $($script:CiArtifact.RunUrl)" }

        # Say it out loud, because this is the one way a -Ci deploy can be
        # mistaken for something it is not: the installed binary is built from
        # a COMMIT. If the working tree has moved on, the binary does not
        # contain the local changes, and the record must not pretend it does.
        $ciCommit = $script:CiArtifact.GitCommit
        if ($ciCommit -and $gitCommit -and $ciCommit -ne $gitCommit) {
            Write-Warn "the CI build is from commit $ciCommit but HEAD is $gitCommit - the binary does not contain your uncommitted work"
        }
        if ($gitDirty) {
            Write-Warn "the working tree is dirty - the CI binary was built from a commit, so local edits are NOT in it"
        }
        Write-Ok "using CI build $buildId"
    } elseif ($SkipBuild) {
        Write-Step 'Reusing the newest verified build (-SkipBuild)'
        $manifestPath = Resolve-BuildManifest -Explicit $BuildManifest -BuildId ''
        if (-not $manifestPath) {
            throw '-SkipBuild needs a build manifest; run build.ps1 first or drop -SkipBuild'
        }
        $manifest = Read-JsonFile $manifestPath
        if (-not $manifest) { throw "build manifest is unreadable: $manifestPath" }
        $buildId = [string](Get-Prop $manifest 'buildId')
        $builtExe = [string](Get-Prop $manifest 'exe')
        $builtSha = [string](Get-Prop $manifest 'sha256')
        $builtAt = ConvertTo-IsoText (Get-Prop $manifest 'builtAt')
        if (-not $buildId -or -not $builtExe -or -not $builtSha) {
            throw "build manifest is missing buildId/exe/sha256: $manifestPath"
        }
        if (-not (Test-Path $builtExe)) {
            throw "the manifest points at a missing executable: $builtExe"
        }
        $actual = Get-Sha256 $builtExe
        if ($actual -ne $builtSha) {
            throw "the executable no longer matches the manifest ($actual != $builtSha); rebuild it"
        }
        $manifestCommit = [string](Get-Prop $manifest 'gitCommit')
        if ($manifestCommit -and $gitCommit -and $manifestCommit -ne $gitCommit -and -not $Force) {
            throw "the build is from commit $manifestCommit, HEAD is $gitCommit; run without -SkipBuild (or pass -Force if you really mean it)"
        }
        Write-Ok "using build $buildId from $manifestPath"
    } else {
        $short = if ($gitShort) { $gitShort } else { 'nogit' }
        $buildId = "app-$short-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'))-$(-join ((1..4) | ForEach-Object { '{0:x}' -f (Get-Random -Minimum 0 -Maximum 16) }))"
        Write-Step "Building $buildId"
        # Do not capture the build's stdout: npm/tauri write a lot of it. The
        # manifest file is the contract.
        & $BuildScript -BuildId $buildId -WorkId $script:WorkId -Agent $Agent -Model $Model | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed (exit code $LASTEXITCODE)" }
        $manifestPath = Resolve-BuildManifest -Explicit '' -BuildId $buildId
        if (-not $manifestPath) {
            $manifestPath = Resolve-BuildManifest -Explicit '' -BuildId ''
        }
        if (-not $manifestPath) { throw "no build manifest was written for $buildId" }
        $manifest = Read-JsonFile $manifestPath
        if (-not $manifest) { throw "build manifest is unreadable: $manifestPath" }
        $builtExe = [string](Get-Prop $manifest 'exe')
        $builtSha = [string](Get-Prop $manifest 'sha256')
        $builtAt = ConvertTo-IsoText (Get-Prop $manifest 'builtAt')
        if ([string](Get-Prop $manifest 'buildId') -ne $buildId) {
            throw "the manifest says build $([string](Get-Prop $manifest 'buildId')), expected $buildId"
        }
        if (-not (Test-Path $builtExe)) { throw "the build did not produce $builtExe" }
        $actual = Get-Sha256 $builtExe
        if ($actual -ne $builtSha) { throw "built executable hash mismatch: $actual != $builtSha" }
        Write-Ok "build $buildId -> $builtExe"
        Write-Dim "sha256: $builtSha"
    }

    $null = Invoke-Ledger @('heartbeat', '--json', "--id=$($script:WorkId)", "--token=$($script:WorkToken)", '--phase=install', "--lease-minutes=$leaseMinutes")

    # -------------------------------------------------------- app processes
    $appState = Prepare-AppProcesses
    if ($appState.Running) {
        Write-Ok "installed app is running (pid $($appState.Processes[0].Id)) - the new build will be staged"
    } else {
        Write-Ok 'installed app is not running - the new build will be installed directly'
    }

    # -------------------------------------------------------------- daemon
    Sync-EnvFile
    $goBuildId = Get-GoBuildId
    $repoDaemon = Join-Path $GoRoot 'bin\t9cloud.exe'
    $daemonSource = $null
    $daemonSha = $null
    $daemonVersion = $null
    $daemonRequired = $Scope -in @('go', 'both')
    $goCommand = Get-Command go -ErrorAction SilentlyContinue

    # A CI build brings its own daemon, stamped with the same source hash the
    # local path would have produced. Using it is the whole point of -Ci: the
    # compile happened on GitHub's runner, not on the machine that keeps
    # running out of memory. The version check still runs, so a CI daemon
    # built from different Go sources can never be installed by accident.
    if ($script:CiArtifact -and $script:CiArtifact.DaemonPath) {
        $daemonSource = $script:CiArtifact.DaemonPath
        $daemonSha = $script:CiArtifact.DaemonSha
        $daemonVersion = $script:CiArtifact.DaemonVersion
        if (-not $daemonVersion) { $daemonVersion = Get-DaemonVersion $daemonSource }
        $script:IntendedDaemonVersion = $daemonVersion
        Write-Ok "daemon taken from CI ($daemonVersion)"
    } elseif ($goBuildId -and $goCommand) {
        # The local path intends to install exactly the daemon the Go sources
        # hash to. Record the INTENTION, not whatever happens to be on disk:
        # if the Go half could not be built, the finish gate has to notice.
        $script:IntendedDaemonVersion = $goBuildId
        $repoDaemonVersion = Get-DaemonVersion $repoDaemon
        $needsGoBuild = -not (Test-Path $repoDaemon) -or $repoDaemonVersion -ne $goBuildId
        if ($needsGoBuild) {
            Write-Step "Building the t9cloud daemon ($goBuildId)"
            New-Item -ItemType Directory -Force -Path (Join-Path $GoRoot 'bin') | Out-Null
            $goOut = Join-Path $GoRoot "bin\t9cloud-$($goBuildId.Substring(3, 8)).exe"
            Push-Location $GoRoot
            try {
                & go build -trimpath -ldflags "-s -w -X github.com/engrtarun/T9EditorLIT/go/internal/api.Version=$goBuildId" -o $goOut ./cmd/t9cloud
                if ($LASTEXITCODE -ne 0) { throw "go build failed (exit code $LASTEXITCODE)" }
            } finally {
                Pop-Location
            }
            $daemonSource = $goOut
            $daemonSha = Get-Sha256 $goOut
            $daemonVersion = Get-DaemonVersion $goOut
            if ($daemonVersion -ne $goBuildId) {
                throw "the built daemon reports version '$daemonVersion', expected '$goBuildId'"
            }
            # Keep the conventional repo path usable for the launchers. A
            # running repo daemon locks its own exe, so this is best-effort.
            try {
                Copy-Item $goOut $repoDaemon -Force
            } catch {
                Write-Warn 'could not refresh go\bin\t9cloud.exe (a repo daemon may be running); the versioned binary is still used'
            }
            Write-Ok "daemon built ($goBuildId)"
        } else {
            $daemonSource = $repoDaemon
            $daemonSha = Get-Sha256 $repoDaemon
            $daemonVersion = $repoDaemonVersion
            Write-Ok "daemon is already built ($daemonVersion)"
        }
    } elseif (Test-Path (Join-Path $InstallDir $DaemonName)) {
        $script:IntendedDaemonVersion = $goBuildId
        $daemonSource = Join-Path $InstallDir $DaemonName
        $daemonSha = Get-Sha256 $daemonSource
        $daemonVersion = Get-DaemonVersion $daemonSource
        if ($goBuildId -and $daemonVersion -ne $goBuildId -and $daemonRequired) {
            throw "go is not installed and the installed daemon is '$daemonVersion', expected '$goBuildId'; install Go and retry"
        }
        Write-Warn "go is not available; keeping the installed daemon ($daemonVersion)"
    } elseif ($daemonRequired) {
        throw 'go is not installed and there is no installed daemon to keep'
    }

    $daemonState = Install-Daemon -Source $daemonSource -Sha $daemonSha -Version $daemonVersion `
        -AppRunning $appState.Running -Required $daemonRequired
    if ($daemonState.Pending) {
        Write-Warn "daemon update is staged; the app's Update click will swap it"
    }

    # A live install leaves an earlier staged binary behind, and the app keys
    # the Update button off that FILE's existence (updateReady), not off the
    # marker. So a stale t9-editor-lit.new.exe from a previous run makes the
    # button offer an older build: clicking it would roll the user backwards.
    # This happened - run7 installed live while run6's staged copy sat there.
    # Clear the staged copies once the live install has been hash-verified.
    if (-not $appState.Running) {
        foreach ($stale in @($StageExe, $StageDaemon)) {
            if ($stale -and (Test-Path -LiteralPath $stale)) {
                try {
                    Remove-Item -LiteralPath $stale -Force
                    Write-Ok "cleared the stale staged binary $(Split-Path -Leaf $stale) - a live install superseded it"
                } catch {
                    Write-Warn "could not remove the stale staged binary $stale; the Update button may offer an older build"
                }
            }
        }
    }

    # Scope go|both is a promise about the daemon. If the daemon that is going
    # out is not the one the Go sources hash to, this deploy did not do what
    # the work order says it did, and reporting SHIPPED would make the record
    # false. Fail here instead: refusing to record a lie is not the same as
    # stalling a build, and other agents keep their own queue position.
    if ($daemonRequired -and ((-not $daemonVersion) -or ($goBuildId -and $daemonVersion -ne $goBuildId))) {
        $have = if ($daemonVersion) { $daemonVersion } else { 'nothing at all' }
        throw "scope '$Scope' promises the t9cloud daemon, but the daemon in use is '$have' while the Go sources hash to '$goBuildId' - the Go changes were NOT deployed"
    }

    # ----------------------------------------------------------- install app
    $appInstall = Install-App -SourceExe $builtExe -Sha256 $builtSha -BuildId $buildId -BuiltAt $builtAt -Manifest $manifest

    $daemonActualVersion = $daemonVersion
    if ($daemonState.Mode -ne 'staged' -and $daemonState.Mode -ne 'missing') {
        $healthNow = Get-DaemonHealth
        if ($healthNow) { $daemonActualVersion = [string](Get-Prop $healthNow 'version') }
    }

    $marker = Write-BuildMarker -Mode $appInstall.Mode -BuildId $buildId -BuiltAt $builtAt `
        -AppSha $builtSha -DaemonBuildId $daemonVersion -DaemonSha $daemonSha `
        -DaemonVersion $daemonActualVersion -Manifest $manifest
    Write-Ok "build.json written (mode $($appInstall.Mode), build $buildId)"

    # ------------------------------------------------------------- verify
    Write-Step 'Verifying what actually landed'
    $liveSha = Get-Sha256 $InstallExe
    $stageSha = Get-Sha256 $StageExe
    $health = Get-DaemonHealth
    $appProcs = @(Get-AppProcesses)
    $foreign = @($appProcs | Where-Object { -not (Test-PathInDir $_.Path $InstallDir) })
    $installedProcs = @($appProcs | Where-Object { Test-PathInDir $_.Path $InstallDir })
    $markerNow = Read-JsonFile $InstallMarker
    $checks = @()

    $appShaNow = if ($appInstall.Mode -eq 'staged') { $stageSha } else { $liveSha }
    $checks += [pscustomobject]@{
        name   = 'app-hash'
        ok     = ($appShaNow -eq $builtSha)
        detail = "installed/staged $appShaNow vs build $builtSha"
    }
    $checks += [pscustomobject]@{
        name   = 'marker-build'
        ok     = ([string](Get-Prop $markerNow 'buildId') -eq $buildId)
        detail = "marker $([string](Get-Prop $markerNow 'buildId')) vs build $buildId"
    }
    $checks += [pscustomobject]@{
        name   = 'marker-app-hash'
        ok     = ([string](Get-Prop $markerNow 'appSha256') -eq $builtSha)
        detail = 'marker build.json carries the app hash'
    }
    $checks += [pscustomobject]@{
        name   = 'no-foreign-app'
        ok     = ($foreign.Count -eq 0)
        detail = "$($foreign.Count) non-installed app instance(s)"
    }
    if ($appInstall.Mode -eq 'staged') {
        $checks += [pscustomobject]@{
            name   = 'staged-app'
            ok     = ($stageSha -eq $builtSha -and $installedProcs.Count -gt 0)
            detail = "stage=$stageSha, installed app running=$($installedProcs.Count -gt 0)"
        }
    } else {
        $checks += [pscustomobject]@{
            name   = 'installed-app'
            ok     = ($liveSha -eq $builtSha)
            detail = "live=$liveSha"
        }
    }
    if ($daemonState.Mode -eq 'staged') {
        $stageDaemonSha = Get-Sha256 $StageDaemon
        $checks += [pscustomobject]@{
            name   = 'staged-daemon'
            ok     = ($stageDaemonSha -eq $daemonSha)
            detail = "t9cloud.new.exe=$stageDaemonSha; localhost applies on the Update click"
        }
    } elseif ($daemonState.Mode -eq 'missing') {
        $checks += [pscustomobject]@{
            name   = 'daemon'
            ok     = $false
            detail = 'daemon is missing'
        }
    } else {
        $healthVersion = if ($health) { [string](Get-Prop $health 'version') } else { $null }
        $checks += [pscustomobject]@{
            name   = 'daemon-live'
            ok     = ($health -and $healthVersion -eq $daemonVersion)
            detail = if ($health) { "http://127.0.0.1:7878 -> $healthVersion (expected $daemonVersion)" } else { 'no /healthz' }
        }
    }

    $failedChecks = @($checks | Where-Object { -not $_.ok })
    $evidence = [ordered]@{
        schema       = 1
        ok           = ($failedChecks.Count -eq 0)
        workId       = $script:WorkId
        runId        = $script:RunId
        buildId      = $buildId
        builtAt      = $builtAt
        mode         = $appInstall.Mode
        agent        = $Agent
        model        = $Model
        session      = $Session
        scope        = $Scope
        etaMinutes   = $EtaMinutes
        createdAt    = (Get-Date).ToUniversalTime().ToString('o')
        git          = [ordered]@{
            commit = $gitCommit
            short  = $gitShort
            branch = $gitBranch
            dirty  = $gitDirty
        }
        manifestPath = $manifestPath
        app          = [ordered]@{
            exe    = $builtExe
            sha256 = $builtSha
        }
        install      = [ordered]@{
            dir           = $InstallDir
            live          = $InstallExe
            liveSha256    = $liveSha
            staged        = $StageExe
            stagedSha256  = $stageSha
            running       = ($installedProcs.Count -gt 0)
            processIds    = @($installedProcs | ForEach-Object { $_.Id })
        }
        marker       = $markerNow
        daemon       = [ordered]@{
            buildId = $daemonVersion
            sha256  = $daemonSha
            version = $daemonActualVersion
            mode    = $daemonState.Mode
            health  = $health
        }
        checks       = $checks
        transcript   = if ($script:TranscriptStarted) { $transcript } else { $null }
    }
    $script:EvidencePath = Write-EvidenceFile $evidence

    foreach ($check in $checks) {
        if ($check.ok) {
            Write-Ok "$($check.name): $($check.detail)"
        } else {
            Write-Bad "$($check.name): $($check.detail)"
        }
    }
    if ($failedChecks.Count -gt 0) {
        throw "verification failed: $(($failedChecks | ForEach-Object { $_.name }) -join ', ')"
    }

    # --------------------------------------------------------------- pin
    if (-not $SkipPin) {
        Write-Step 'Refreshing the Start menu / taskbar shortcut'
        $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue)
        if ($pwsh) {
            & $pwsh.Source -NoProfile -File $PinScript -InstallDir $InstallDir | Out-Host
            if ($LASTEXITCODE -ne 0) {
                Write-Warn 'the shell refused the pin - the Start menu shortcut is still updated'
            }
        } else {
            Write-Warn 'pwsh not found; skipping the taskbar pin'
        }
    }

    # ------------------------------------------------------------- launch
    if ($Launch) {
        if ($appInstall.Mode -eq 'staged') {
            Write-Warn 'the app is already running; click Update in its top bar to apply the staged build'
        } else {
            Write-Step 'Starting the installed app'
            Start-Process -FilePath $InstallExe
            Start-Sleep -Seconds 3
            $runningNow = @(Get-AppProcesses | Where-Object { Test-PathInDir $_.Path $InstallDir })
            if ($runningNow.Count -gt 0) { Write-Ok "app started (pid $($runningNow[0].Id))" }
            else { Write-Warn 'the app did not stay running; run deploy.ps1 -Doctor' }
        }
    }

    # ------------------------------------------------------------- finish
    # The honesty gate lives HERE, and deliberately not in the daemon block:
    # two runs in a row (run7 scope=both, run9 scope=go) never reached that
    # block at all, so a check placed there could not fire - and both orders
    # reported SHIPPED while t9cloud.exe stayed exactly as it was. Every
    # successful deploy passes this point, so this is the one place where a
    # work order that promised the daemon can be stopped from lying.
    #
    # It refuses rather than warns. "shipped" is the only word the ledger
    # offers for success, and a shipped order that did not ship the thing its
    # task names is worse than a failed one: the next reader trusts it.
    if ($Scope -in @('go', 'both')) {
        # Compare the INSTALLED daemon against the daemon this work order
        # intended to install - not against the local source hash, which is a
        # different question when the build came from CI.
        $intended = $script:IntendedDaemonVersion
        $liveDaemon = Join-Path $InstallDir $DaemonName
        $liveVer = $null
        if (Test-Path -LiteralPath $liveDaemon) {
            try { $liveVer = Get-DaemonVersion $liveDaemon } catch { $liveVer = $null }
        }
        if (-not $intended) {
            throw "scope '$Scope' promises the t9cloud daemon, but no daemon was ever chosen for this work order, so there is nothing to claim as shipped. Refusing to record this as shipped."
        }
        if (-not $liveVer -or $liveVer -ne $intended) {
            throw "scope '$Scope' promises the t9cloud daemon, but the installed daemon is '$liveVer' while this work order intended '$intended'. The Go changes were NOT deployed, so this is not shipped."
        }
        # The intended version and the local sources can still differ: that
        # is what uncommitted Go edits look like. The daemon that shipped is
        # the right one; the local edits are simply not inside it, and the
        # operator deserves to hear that rather than discover it later.
        $localId = $null
        try { $localId = Get-GoBuildId } catch { $localId = $null }
        if ($localId -and $localId -ne $intended) {
            Write-Warn "the installed daemon is '$intended' but the local Go sources hash to '$localId' - uncommitted Go changes are NOT in the installed daemon"
        }
    }

    Stop-Heartbeat
    $finishArgs = @(
        'finish', '--json',
        "--id=$($script:WorkId)",
        "--token=$($script:WorkToken)",
        "--outcome=shipped",
        "--mode=$($appInstall.Mode)",
        "--build-id=$buildId",
        "--evidence=$($script:EvidencePath)"
    )
    # Do not name this $finished: PowerShell variables are case-insensitive, so it
    # would collide with the $script:Finished guard and turn into $true.
    $finishResult = Invoke-Ledger $finishArgs
    $script:Finished = $true
    Close-Session

    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host "  SHIPPED  $($script:WorkId)" -ForegroundColor Green
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host "  build:   $buildId" -ForegroundColor Gray
    Write-Host "  model:   $Agent / $Model" -ForegroundColor Gray
    if ($appInstall.Mode -eq 'staged') {
        Write-Host '  app:     STAGED - the running app shows Update within 5 s; click it.' -ForegroundColor Yellow
    } else {
        Write-Host "  app:     INSTALLED - taskbar starts $InstallExe" -ForegroundColor Green
    }
    if ($daemonState.Mode -eq 'staged') {
        Write-Host '  daemon:  STAGED - the same Update click swaps it.' -ForegroundColor Yellow
    } elseif ($daemonState.Mode -eq 'missing') {
        Write-Host '  daemon:  MISSING - cloud features stay offline.' -ForegroundColor Yellow
    } else {
        Write-Host "  daemon:  LIVE $daemonActualVersion at http://127.0.0.1:7878" -ForegroundColor Green
    }
    $duration = Get-Prop $finishResult 'durationMinutes'
    $etaDelta = Get-Prop $finishResult 'etaDeltaMinutes'
    if ($null -ne $duration) {
        $deltaText = if ($null -ne $etaDelta) {
            $sign = if ([double]$etaDelta -gt 0) { '+' } else { '' }
            "$sign$etaDelta min vs ETA $EtaMinutes min"
        } else {
            "ETA $EtaMinutes min"
        }
        Write-Host "  ledger:  shipped in $duration min ($deltaText)" -ForegroundColor Gray
    } else {
        Write-Host '  ledger:  shipped (this work order was already closed)' -ForegroundColor Gray
    }
    Write-Host "  proof:   $($script:EvidencePath)" -ForegroundColor DarkGray
    Write-Host "  log:     $transcript" -ForegroundColor DarkGray
    Write-Host ''
    if ($appInstall.Mode -eq 'staged') {
        Write-Host '  Nothing else to do. Do not say "I will notify later" - the app is' -ForegroundColor Yellow
        Write-Host '  waiting for the user to click Update, and the ledger says shipped.' -ForegroundColor Yellow
    } else {
        Write-Host '  Nothing else to do. The taskbar icon opens this exact build.' -ForegroundColor Green
    }
    Write-Host ''
} catch {
    $message = $_.Exception.Message
    Write-Host ''
    Write-Bad $message
    if ($script:WorkId -and -not $script:Finished) {
        $failure = [ordered]@{
            schema    = 1
            ok        = $false
            workId    = $script:WorkId
            buildId   = if ($buildId) { $buildId } else { $null }
            agent     = $Agent
            model     = $Model
            error     = $message
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        try {
            $script:EvidencePath = Write-EvidenceFile $failure
        } catch {
            Write-Warn 'could not write the failure evidence file'
        }
        $null = Close-WorkOrder -Outcome 'failed' -ErrorText $message -Evidence $script:EvidencePath
        Close-Session
    }
    $script:ExitCode = 5
} finally {
    Stop-Heartbeat
    if ($script:DeployLock) {
        $script:DeployLock.Close()
        $script:DeployLock = $null
    }
    if ($script:TranscriptStarted) {
        try {
            Stop-Transcript | Out-Null
        } catch {
            # transcript already gone
        }
    }
}

exit $script:ExitCode
