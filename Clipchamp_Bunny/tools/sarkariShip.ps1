<#
.SYNOPSIS
    One command that takes a change from the working tree to the user's desktop.

.DESCRIPTION
    The multi-agent flow has four steps and every one of them can be got
    wrong in a hurry: verify, commit, push, deploy. This script does all
    four, in the right order, with the two failure modes that actually bite
    handled:

      1. VERIFY   npm run verify:fast - types, Svelte, unit tests, cargo
                  check. No linker, so it never OOMs and never takes the
                  build lock away from another agent.

      2. COMMIT   The tree is shared, so by default this commits EVERYTHING
                  in it - including work another agent left here. That is
                  how the repository has always behaved, and pretending
                  otherwise would be worse than saying it out loud. Pass
                  -Paths to commit only your own files.

      3. PUSH     A push can be rejected because somebody else pushed
                  first. This rebases onto the new HEAD and pushes again,
                  once, rather than leaving the agent to discover it.

      4. DEPLOY   deploy.ps1 -Ci. The deploy asks CI for the artifact of
                  the commit that was just pushed, and WAITS for it if CI
                  has not built it yet. It never installs a different
                  agent's build.

    The compile happens on GitHub's runner. Nothing is compiled on this
    machine - see AGENTS.md section 11.

.PARAMETER Agent
    Who is deploying. Defaults to $env:T9_AGENT.

.PARAMETER Model
    Exact model id, provider/model.

.PARAMETER Task
    What changed. 8+ characters. It goes into the ledger.

.PARAMETER Why
    Why it matters. 15+ characters.

.PARAMETER EtaMinutes
    Your honest estimate, 1..480 minutes. Required: this wrapper has no
    default ETA, because a made-up estimate poisons the ledger accuracy.

.PARAMETER Scope
    app | go | both | docs.

.PARAMETER Message
    The commit message. Defaults to the Task.

.PARAMETER Paths
    Only these paths are committed. Everything, by default.

.PARAMETER NoPush
    Stop after the commit.

.PARAMETER NoDeploy
    Stop after the push.

.EXAMPLE
    pwsh -File tools\sarkariShip.ps1 -Agent "opencode/beam-free" `
        -Model "opencode/beam-free" -Task "add the thumbnail menu action" `
        -Why "the card menu had no thumbnail action at all" -EtaMinutes 10 -Scope app
#>
[CmdletBinding()]
param(
    [string]$Agent = $env:T9_AGENT,
    [string]$Model = $env:T9_MODEL,
    [string]$Task = $env:T9_TASK,
    [string]$Why = $env:T9_WHY,
    [ValidateSet('app', 'go', 'both', 'docs')]
    [string]$Scope = 'app',
    [int]$EtaMinutes = 0,
    [int]$Priority = 50,
    [switch]$Emergency,
    [string]$Message = '',
    [string[]]$Paths = @(),
    [switch]$NoPush,
    [switch]$NoDeploy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$AppDir = $PSScriptRoot | Split-Path -Parent
$RepoRoot = $AppDir | Split-Path -Parent
$DeployScript = Join-Path $PSScriptRoot 'deploy.ps1'

function Write-Step([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok([string]$m) { Write-Host "    [ok] $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Write-Bad([string]$m) { Write-Host "    [x] $m" -ForegroundColor Red }

# Validate before verify/commit/push. Otherwise a missing ETA or identity
# would still push the commit and only fail at the deploy form - the agent
# would have moved main and learned nothing until the last step.
$agentText = ([string]$Agent).Trim()
$modelText = ([string]$Model).Trim()
$taskText = ([string]$Task).Trim()
$whyText = ([string]$Why).Trim()
if ($agentText.Length -lt 2) { Write-Bad 'a real -Agent is required (2+ characters); no invented fallback is used.'; exit 2 }
if ($modelText.Length -lt 3) { Write-Bad 'a real -Model is required (3+ characters); no invented fallback is used.'; exit 2 }
if ($taskText.Length -lt 8) { Write-Bad 'a real -Task is required (8+ characters).'; exit 2 }
if ($whyText.Length -lt 15) { Write-Bad 'a real -Why is required (15+ characters).'; exit 2 }
if ($EtaMinutes -lt 1 -or $EtaMinutes -gt 480) { Write-Bad 'a real -EtaMinutes is required (1..480); this wrapper has no default ETA.'; exit 2 }

# ---------------------------------------------------------------- 1. verify
Write-Step 'Verifying (types, Svelte, unit tests, cargo check - no linker)'
Push-Location $RepoRoot
try {
    & npm run verify:fast
    if ($LASTEXITCODE -ne 0) {
        throw "verification failed (exit $LASTEXITCODE) - nothing was committed"
    }
} finally {
    Pop-Location
}
Write-Ok 'the tree verifies'

# ---------------------------------------------------------------- 2. commit
Write-Step 'Committing'
Push-Location $RepoRoot
try {
    $dirty = @(git status --porcelain)
    if ($dirty.Count -eq 0) {
        Write-Ok 'nothing to commit'
    } else {
        if ($Paths.Count -gt 0) {
            foreach ($p in $Paths) { git add -- $p }
            Write-Ok "staged only: $($Paths -join ', ')"
        } else {
            git add -A
            Write-Warn "the tree is shared, so this commits EVERYTHING in it ($($dirty.Count) files) - including work another agent left here. Use -Paths to commit only yours."
        }
        $staged = @(git diff --cached --name-only)
        if ($staged.Count -eq 0) {
            Write-Ok 'nothing staged'
        } else {
            $msg = if ($Message) { $Message } else { $Task }
            if (-not $msg) { $msg = 'work from the sarkari agents' }
            # With -Paths, commit ONLY those paths. A plain commit would also
            # pick up anything another agent had already staged, which is not
            # what "only my files" means.
            if ($Paths.Count -gt 0) {
                git commit --only -m $msg -- @Paths
            } else {
                git commit -m $msg
            }
            if ($LASTEXITCODE -ne 0) { throw "git commit failed (exit $LASTEXITCODE)" }
            Write-Ok "committed $((git rev-parse HEAD) -replace '^(.{7}).*','$1') ($($staged.Count) files)"
        }
    }
    $commit = (git rev-parse HEAD).Trim()
} finally {
    Pop-Location
}

if ($NoPush) { Write-Ok 'stopped before the push (-NoPush)'; exit 0 }

# ------------------------------------------------------------------ 3. push
Write-Step 'Pushing'
Push-Location $RepoRoot
try {
    git push origin HEAD:main 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        # Somebody else pushed first. Rebase onto them and push again, once.
        # A second failure is reported rather than retried forever: the tree
        # is shared, and a conflict here is a conversation, not a loop.
        Write-Warn 'the push was rejected - rebasing onto the new HEAD and trying once more'
        git pull --rebase origin main 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw 'the rebase failed - resolve the conflict by hand, then run this again'
        }
        git push origin HEAD:main 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "the push failed again (exit $LASTEXITCODE)"
        }
    }
    # A rebase rewrites the commit. The deploy must wait for the artifact of
    # what is actually on HEAD now, not the pre-rebase hash that CI will never
    # publish.
    $commit = (git rev-parse HEAD).Trim()
    Write-Ok "pushed $commit"
} finally {
    Pop-Location
}

if ($NoDeploy) { Write-Ok 'stopped before the deploy (-NoDeploy)'; exit 0 }

# ---------------------------------------------------------------- 4. deploy
Write-Step 'Deploying (CI compiles; this installs, it does not build)'
$deployArgs = @{
    '-Ci'         = $true
    '-Agent'      = $Agent
    '-Model'      = $Model
    '-Task'       = $Task
    '-Why'        = $Why
    '-Scope'      = $Scope
    '-EtaMinutes' = $EtaMinutes
    '-Priority'   = $Priority
}
if ($Emergency) { $deployArgs['-Emergency'] = $true }
# The commit that was just pushed. The deploy waits for ITS artifact, so it
# cannot install a different agent's build.
$deployArgs['-ExpectCommit'] = $commit

& pwsh -NoProfile -ExecutionPolicy Bypass -File $DeployScript @deployArgs
$code = $LASTEXITCODE
if ($code -ne 0) {
    Write-Bad "the deploy failed (exit $code) - the ledger has the reason"
    exit $code
}
Write-Ok 'shipped'
exit 0
