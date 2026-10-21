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

    Then it serialises the queue (one active deploy), takes the executable
    that CI built, installs the app, updates the t9cloud daemon, writes the
    build.json marker, verifies every hash, and closes the work order as
    `shipped`. The ledger is the only truthful status: "build is running" or
    "I will notify you later" is not a status.

    THE COMPILE IS NOT HAPPENING HERE. It happens on GitHub's runner
    (.github\workflows\ci.yml), which publishes a rolling `ci-latest` release
    holding the app, the daemon and a SHA-256 manifest. This script
    downloads that, checks the hashes, and installs. A release build on this
    8 GB box took six to twelve minutes, held the build lock that every
    other agent was waiting behind, and died in the linker for want of
    memory - so it is not a fallback, it is simply not here any more.

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
    # The commit whose artifact to install. Empty means the commit this
    # working tree is on. With several agents pushing, naming the commit is
    # what stops an agent being handed somebody else's build.
    [string]$ExpectCommit = '',
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

# The classic pipeline that used to live here has been removed.
#
# It compiled the release ON THIS MACHINE: six to twelve minutes, a build
# lock every other agent had to wait behind, and a linker that ran out of
# memory on an 8 GB box. It was also a SECOND copy of a pipeline that
# already existed in sarkari_deploy\ - and two copies of one pipeline is
# how the Go daemon went missing for three deploys: the live path never
# had a daemon build in it, and the copy nobody ran was the one that did.
#
# The compile now happens on GitHub's runner (.github\workflows\ci.yml)
# and sarkari_deploy\sarkariKaam.ps1 installs what it built.
if ($PSBoundParameters.ContainsKey('Legacy')) {
    Write-Error 'the classic deploy pipeline has been removed - the compile now happens in CI. Use deploy.ps1 (it forwards to sarkari_deploy\sarkariDeploy.ps1) or sarkari_deploy\sarkariDeploy.ps1 directly.'
    exit 2
}

