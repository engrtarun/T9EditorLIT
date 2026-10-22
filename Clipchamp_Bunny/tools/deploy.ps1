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

.PARAMETER Force
    Allow the explicitly dangerous paths only: a tracked-dirty working tree,
    an -ExpectCommit other than HEAD, a custom test install folder, or a
    manual rollback. It never authorizes a local compile and never turns a
    custom artifact source into a live desktop install.

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
    # Environment values are applied by sarkariForm AFTER a -FormFile is read,
    # so a form file is not silently overridden by a stale T9_* variable in the
    # agent's shell. Command-line values still win over both.
    [string]$Agent = '',
    [string]$Model = '',
    [string]$Session = '',
    [string]$Task = '',
    [string]$Why = '',
    [string]$RootCause = '',
    [string]$TestingDone = '',
    [string]$ModulesAffected = '',
    [switch]$IsBreakingChange,
    [int]$EtaMinutes = 0,
    [ValidateSet('app', 'go', 'both', 'docs')]
    [string]$Scope = 'app',
    [int]$Priority = 50,
    [switch]$Emergency,
    # Skip the interactive questions. This is NOT a source of defaults: task,
    # why and ETA still have to be supplied.
    [switch]$Fast,
    # -Ci is kept only so existing commands (sarkariShip.ps1, agent scripts)
    # keep working. There is no local compile path any more, so this switch
    # no longer selects anything: the Sarkari engine always fetches the
    # artifact GitHub's runner built and installs it.
    [switch]$Ci,
    [string]$CiRelease = 'ci-latest',
    [string]$CiRepo = '',
    [string]$CiBaseUrl = '',
    # The commit whose artifact to install. Empty means the commit this
    # working tree is on. With several agents pushing, naming the commit is
    # what stops an agent being handed somebody else's build.
    [string]$ExpectCommit = '',
    [switch]$Launch,
    [switch]$Interactive,
    [string]$FormFile = '',
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\T9EditorLIT'),
    [switch]$Doctor,
    [switch]$Status,
    [switch]$Force,
    # Declared here even though the Sarkari engine owns it. PowerShell binds
    # -File arguments against THIS param block before the bridge below runs,
    # so without it the documented `pwsh -File tools\deploy.ps1 -Check` died
    # with "A parameter cannot be found" and never reached the engine.
    [switch]$Check
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
# There is exactly one path from source to the installed app: the Sarkari
# engine fetches the artifact GitHub's runner built, verifies its SHA-256 and
# installs it. The classic pipeline that compiled here - and the -Legacy
# opt-out that reached it - have been deleted, not disabled.
$SarkariDeploy = Join-Path $RepoRoot 'sarkari_deploy\sarkariDeploy.ps1'
if (-not (Test-Path $SarkariDeploy)) {
    Write-Error "the Sarkari deploy engine is missing at $SarkariDeploy - deploy cannot continue without it."
    exit 2
}

# Forward the EFFECTIVE values, not just @PSBoundParameters. The old bridge
# forwarded only switches the caller typed, so `T9_AGENT` / `T9_MODEL` /
# `T9_TASK` defaults set in this param block were silently dropped before the
# engine saw them. The explicit hashtable also guarantees this door can never
# pass an option the engine does not implement.
$forward = @{
    Agent       = $Agent
    Model       = $Model
    Session     = $Session
    Task        = $Task
    Why         = $Why
    RootCause   = $RootCause
    TestingDone = $TestingDone
    ModulesAffected = $ModulesAffected
    IsBreakingChange = [bool]$IsBreakingChange
    EtaMinutes  = $EtaMinutes
    Scope       = $Scope
    Priority    = $Priority
    Emergency   = [bool]$Emergency
    Fast        = [bool]$Fast
    Ci          = [bool]$Ci
    CiRelease   = $CiRelease
    CiRepo      = $CiRepo
    CiBaseUrl   = $CiBaseUrl
    ExpectCommit = $ExpectCommit
    Launch      = [bool]$Launch
    Interactive = [bool]$Interactive
    FormFile    = $FormFile
    InstallDir  = $InstallDir
    Doctor      = [bool]$Doctor
    Status      = [bool]$Status
    Force       = [bool]$Force
    Check       = [bool]$Check
}

# `pwsh -File` cannot carry an empty string: on the child's command line it
# collapses to a bare token and the NEXT parameter's name is swallowed as its
# value - forwarding CiRepo='' made the engine see CiBaseUrl='-CiRepo:', which
# tripped the "custom artifact source" guard on a deploy that named no custom
# source at all. The engine's own defaults for these strings are empty, so
# dropping an empty value is a no-op semantically and keeps the binding honest.
# Booleans and numbers are unaffected (0/false are real forwarded values).
$effective = $forward
$forward = @{}
foreach ($kv in $effective.GetEnumerator()) {
    if ($kv.Value -is [string] -and $kv.Value -eq '') { continue }
    $forward[$kv.Key] = $kv.Value
}

& pwsh -NoProfile -ExecutionPolicy Bypass -File $SarkariDeploy @forward
exit $LASTEXITCODE

