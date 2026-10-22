<#
.SYNOPSIS
    The SQLite ledger bridge for the Sarkari deploy engine.

.DESCRIPTION
    AGENTS.md says the ledger is the only truth:

        "Ledger hi sach hai: `shipped` ke bina desktop pe change nahi
         pahuncha."

    The Sarkari engine has its own JSON records, but a JSON file is not the
    queue: it cannot say *who is deploying right now*, *whose turn is it*,
    or *how long did agent X actually take against the ETA it promised*.
    Those are exactly the questions the SQLite ledger answers, and the
    `deploy.ps1` protocol in docs/AGENT_DEPLOY_PROTOCOL.md is written
    against them.

    So the Sarkari engine writes to the same ledger. This module is the
    only place that knows how, which keeps the change small and the
    protocol honest:

        request  -> the work order is queued (FIFO + priority aging)
        claim    -> it becomes the one active deploy
        heartbeat-> the lease is kept alive during a long build
        finish   -> shipped / failed / cancelled, with the build id

    If the ledger is unreachable, the deploy still runs: a missing ledger
    must not be able to block the user's desktop. It is reported loudly
    instead, because a silent fallback is how the truth gets lost.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# This file is dot-sourced by sarkariKaam.ps1, so it must not change the
# caller's preferences - it only adds functions. The value is captured and
# restored around the definitions below.
$script:SarkariLedgerSavedPreference = $ErrorActionPreference

function Get-SarkariLedgerScript {
    $root = Split-Path -Parent $PSScriptRoot
    $p = Join-Path $root 'Clipchamp_Bunny\tools\deploy-ledger.mjs'
    if (-not (Test-Path $p)) {
        $p = Join-Path $root 'tools\deploy-ledger.mjs'
    }
    return $p
}

function Invoke-SarkariLedger {
    <#
    .SYNOPSIS
        Run one ledger command and return the parsed JSON.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string[]]$Arguments,
        # Optional ledger file override. Unset in production, where the CLI
        # resolves its own default; set only by tests that must not touch the
        # real queue every agent is waiting in.
        [string]$DbPath = ''
    )

    $script = Get-SarkariLedgerScript
    if (-not (Test-Path $script)) {
        Write-Host "    [!] ledger script not found at $script - the queue will not see this deploy" -ForegroundColor Yellow
        return $null
    }
    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) {
        Write-Host "    [!] node not found - the queue will not see this deploy" -ForegroundColor Yellow
        return $null
    }
    if ($DbPath) { $Arguments = @($Arguments + @('--db', $DbPath)) }
    try {
        $raw = & $node.Source $script @Arguments 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Write-Host "    [!] ledger command failed: $($raw.Trim())" -ForegroundColor Yellow
            return $null
        }
        $start = $raw.IndexOf('{')
        if ($start -lt 0) { return $null }
        return ($raw.Substring($start) | ConvertFrom-Json)
    } catch {
        Write-Host "    [!] ledger unreachable: $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

function New-SarkariLedgerOrder {
    <#
    .SYNOPSIS
        Queue the work order in the SQLite ledger.
    .DESCRIPTION
        Returns the ledger order (id + token), or $null when the ledger
        could not be reached. The caller keeps going either way.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [pscustomobject]$AgentProfile,
        [string]$Scope = 'app',
        [int]$Priority = 50,
        [switch]$Emergency,
        [string]$Session = '',
        [string]$Commit = '',
        [string]$Branch = '',
        [switch]$GitDirty,
        [switch]$GitClean
    )

    # Every field is read defensively. Under `Set-StrictMode -Version Latest`
    # a property that is merely *absent* is a terminating error, and this
    # request runs on the deploy's critical path - so a profile built by an
    # older or different code path would kill the deploy instead of costing
    # one pretty line of queue metadata.
    function Read-ProfileText([object]$Profile, [string]$Name, [string]$Fallback) {
        $prop = if ($null -ne $Profile) { $Profile.PSObject.Properties[$Name] } else { $null }
        if ($prop -and $prop.Value) { return [string]$prop.Value }
        return $Fallback
    }
    $taskText = Read-ProfileText $AgentProfile 'Task' 'deploy task'
    $whyText = Read-ProfileText $AgentProfile 'Why' 'no reason recorded by this profile'
    $etaText = Read-ProfileText $AgentProfile 'EtaMinutes' '20'
    $sessionText = if ($Session) { $Session } else { Read-ProfileText $AgentProfile 'WorkId' ("S-" + [guid]::NewGuid().ToString('N').Substring(0, 12)) }

    # The ledger's schema caps `task` at 200 characters (deploy-ledger.mjs:
    # exactText(input.task, 'task', 8, 200)). An agent writing an ordinary
    # sentence crosses that limit without meaning to, and the consequence is
    # silent: the request is rejected, NO work order is issued, and the build
    # then runs with no lease at all - which breaks the one rule this
    # pipeline exists to keep, that the ledger is the truth. It happened on a
    # real deploy that still reported SHIPPED afterwards.
    #
    # Clamp it here, where the value is still just text, so a work order is
    # always created. The tail cannot survive the cap, so say so out loud
    # instead of quietly losing it.
    if ($taskText.Length -gt 200) {
        $taskText = $taskText.Substring(0, 197) + '...'
        Write-Host '    [!] Task was longer than the ledger allows (200 chars) and has been truncated; -Why carries the rest' -ForegroundColor Yellow
    }

    $args = @(
        'request',
        '--agent', (Read-ProfileText $AgentProfile 'AgentName' 'unknown-agent'),
        '--model', (Read-ProfileText $AgentProfile 'ModelName' 'unknown-model'),
        '--task', $taskText,
        '--why', $whyText,
        '--eta', $etaText,
        '--scope', $Scope,
        '--priority', "$Priority",
        '--session', $sessionText,
        '--json'
    )
    if ($Emergency) { $args += '--emergency' }
    if ($Commit) { $args += @('--commit', $Commit) }
    if ($Branch) { $args += @('--branch', $Branch) }
    # The CLI reads the presence of --git-dirty as true, so only add it for a
    # dirty tree. `--git-dirty false` would still be true in JavaScript. A
    # clean tree gets the explicit --git-clean flag, so the ledger records
    # false instead of NULL ("nobody checked").
    if ($GitDirty) { $args += '--git-dirty' }
    elseif ($GitClean) { $args += '--git-clean' }

    $order = Invoke-SarkariLedger -Arguments $args
    # The CLI answers with the work order itself: `workId` and `token`.
    # There is no `ok` field on this command.
    if (-not $order -or -not $order.workId -or -not $order.token) {
        Write-Host "    [!] the queue could not be told about this deploy" -ForegroundColor Yellow
        return $null
    }

    Write-Host "    [ok] queued in the shared ledger: $($order.workId) (position $($order.position))" -ForegroundColor Green
    return $order
}

function Start-SarkariLedgerOrder {
    <#
    .SYNOPSIS
        Claim the queued order, making it the one active deploy.
    .DESCRIPTION
        The ledger allows exactly one active deploy. If somebody else holds
        it, the CLI answers `state: waiting` with the queue position and the
        work that is ahead. That is not a failure: this order waits its turn.

        So the claim is retried until the slot is free or the wait grows
        past the order's own ETA - at which point the caller is told the
        truth instead of pretending the deploy owns the machine.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [pscustomobject]$Order,
        [int]$LeaseMinutes = 0,
        [int]$MaxWaitMinutes = 0,
        [string]$DbPath = ''
    )

    if ($MaxWaitMinutes -le 0) { $MaxWaitMinutes = [int]$Order.etaMinutes }
    # The CLI validates leaseMinutes to 5..240 and rejects anything else with
    # a non-zero exit. A short ETA (an agent may sanction 2 minutes) produced
    # `--lease-minutes 2`, and then *every* claim failed permanently - the
    # deploy could never take the lane even though the queue was free.
    if ($LeaseMinutes -lt 5) { $LeaseMinutes = 5 }
    if ($LeaseMinutes -gt 240) { $LeaseMinutes = 240 }
    $deadline = (Get-Date).AddMinutes($MaxWaitMinutes)
    $attempt = 0
    # A single failed ledger call used to abandon the whole wait (`return
    # $null`), which stopped every later heartbeat - and a queued order with
    # no heartbeat is reaped after QUEUE_TTL, so the deploy then failed with
    # "the agent vanished". Under 1 GB free RAM `node` is exactly what hangs,
    # so transient failures are normal and must be tolerated.
    $consecutiveFailures = 0
    $maxConsecutiveFailures = 6

    while ($true) {
        $attempt++
        $args = @('claim', '--id', $Order.workId, '--token', $Order.token, '--json')
        if ($LeaseMinutes -gt 0) { $args += @('--lease-minutes', "$LeaseMinutes") }

        $claimed = Invoke-SarkariLedger -Arguments $args -DbPath $DbPath
        if (-not $claimed) {
            $consecutiveFailures++
            if ($consecutiveFailures -ge $maxConsecutiveFailures) {
                Write-Host "    [!] the ledger did not answer $consecutiveFailures times in a row - giving up" -ForegroundColor Yellow
                return $null
            }
            Write-Host "    [..] ledger call failed ($consecutiveFailures of $maxConsecutiveFailures) - retrying, the queue slot is still ours" -ForegroundColor Yellow
        } else {
            $consecutiveFailures = 0
        }
        if ($claimed -and $claimed.state -eq 'active') {
            Write-Host "    [ok] active in the shared ledger: $($Order.workId) (run $($claimed.runId))" -ForegroundColor Green
            # The claim response carries the run id and the state, but NOT the
            # secret token - the server never repeats it. So the token owner
            # stays the requested order, and the claim metadata is attached
            # to it. Returning the claim response instead would leave the
            # heartbeat and finish steps with an empty token.
            $Order | Add-Member -NotePropertyName RunId -NotePropertyValue $claimed.runId -Force
            $Order | Add-Member -NotePropertyName State -NotePropertyValue $claimed.state -Force
            $Order | Add-Member -NotePropertyName LeaseUntil -NotePropertyValue $claimed.leaseUntil -Force
            return $Order
        }
        if ($null -eq $claimed) {
            # No answer this round: refresh the lease on our own so the queue
            # cannot reap the order while `node` is struggling.
            $null = Invoke-SarkariLedger -Arguments @(
                'heartbeat', '--id', $Order.workId, '--token', $Order.token, '--phase', 'queued', '--json'
            ) -DbPath $DbPath
            $leftFail = [int]([math]::Max(0, ($deadline - (Get-Date)).TotalMinutes))
            if ($leftFail -le 0) {
                Write-Host '    [!] gave up waiting for the queue slot' -ForegroundColor Yellow
                return $null
            }
            Start-Sleep -Seconds 20
            continue
        }
        if ($claimed.state -ne 'waiting') {
            Write-Host "    [!] the queue did not hand over the slot (state: $($claimed.state))" -ForegroundColor Yellow
            return $null
        }

        $ahead = if ($claimed.etaAheadMinutes) { "$($claimed.etaAheadMinutes)m" } else { '?' }
        $left = [int]([math]::Max(0, ($deadline - (Get-Date)).TotalMinutes))
        Write-Host "    [..] the queue is busy - position $($claimed.position), about $ahead of work ahead" -ForegroundColor Yellow
        if ($left -le 0) {
            Write-Host '    [!] gave up waiting for the queue slot' -ForegroundColor Yellow
            return $null
        }
        # The slot frees up when the other deploy finishes; poll gently.
        Start-Sleep -Seconds 20
    }
}

function Update-SarkariLedgerHeartbeat {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [pscustomobject]$Order,
        [string]$Phase = 'building'
    )

    $null = Invoke-SarkariLedger -Arguments @(
        'heartbeat', '--id', $Order.workId, '--token', $Order.token, '--phase', $Phase, '--json'
    )
}

function Complete-SarkariLedgerOrder {
    <#
    .SYNOPSIS
        Close the work order with the real outcome.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [pscustomobject]$Order,
        [Parameter(Mandatory=$true)]
        [ValidateSet('shipped', 'failed', 'cancelled')]
        [string]$Outcome,
        [string]$Mode = '',
        [string]$BuildId = '',
        [string]$Evidence = '',
        [string]$ErrorText = ''
    )

    $args = @(
        'finish', '--id', $Order.workId, '--token', $Order.token, '--outcome', $Outcome, '--json'
    )
    if ($Mode) { $args += @('--mode', $Mode) }
    if ($BuildId) { $args += @('--build-id', $BuildId) }
    if ($Evidence) { $args += @('--evidence', $Evidence) }
    if ($ErrorText) { $args += @('--error', $ErrorText) }

    $done = Invoke-SarkariLedger -Arguments $args
    # The CLI answers with the new `status` ("shipped" / "failed" /
    # "cancelled"), not a boolean.
    if ($done -and $done.status) {
        Write-Host "    [ok] ledger says: $($done.status)" -ForegroundColor Green
    } else {
        Write-Host '    [!] the ledger was not closed cleanly - run deploy.ps1 -Status' -ForegroundColor Yellow
    }
    return $done
}
