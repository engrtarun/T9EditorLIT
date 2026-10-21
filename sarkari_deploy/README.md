# Sarkari Deploy — the shared queue

The Sarkari engine is the fast lane of the **same** deploy door that
`Clipchamp_Bunny\tools\deploy.ps1` is. It is not a second, parallel path:
`deploy.ps1` forwards to `sarkari_deploy\sarkariDeploy.ps1` unless `-Legacy`
is passed.

## The queue is the SQLite ledger

AGENTS.md is explicit:

> **Ledger hi sach hai:** `shipped` ke bina desktop pe change nahi pahuncha.

The engine has its own JSON records under `sarkari_deploy\records\`, but a
JSON file is not a queue. It cannot say _who is deploying right now_, _whose
turn is it_, or _how long did agent X actually take against the ETA it
promised_. Those questions belong to the SQLite ledger that
`docs/AGENT_DEPLOY_PROTOCOL.md` is written against.

So the engine writes to that same ledger, through
`sarkari_deploy\sarkariLedger.ps1`:

| Step                                     | Command                  |
| ---------------------------------------- | ------------------------ |
| queue the work order                     | `request`                |
| take the one active slot                 | `claim`                  |
| keep the lease alive during a long build | `heartbeat` (every 45 s) |
| close it with the real outcome           | `finish`                 |

`deploy.ps1 -Status` therefore shows Sarkari deploys and classic deploys in
the same queue, which is the point: an agent that is waiting needs to see
who it is waiting for.

### The shape of the answers

The CLI answers differently per command, and the helper checks the right
field for each:

| Command   | Field to check     | Values                             |
| --------- | ------------------ | ---------------------------------- |
| `request` | `workId` + `token` | the work order and its secret      |
| `claim`   | `state`            | `active` / `waiting`               |
| `finish`  | `status`           | `shipped` / `failed` / `cancelled` |

`claim` never repeats the token, so the token owner stays the _requested_
order and the claim metadata (run id, state) is attached to it. Returning
the claim response instead leaves the heartbeat and finish steps with an
empty token.

### Waiting for the slot

`claim` only hands the slot to the order that is **first in line**, so:

- `state: waiting` means somebody else has it, or you are not first yet. The
  answer carries the position and the work that is ahead.
- The helper retries until the slot is free, then gives up rather than
  pretending the deploy owns the machine.
- **A dead order at the head of the queue blocks everyone** until the
  ledger's queued TTL (15 minutes) expires it. If a deploy looks stuck with
  nobody active, look at the head of the queue:
  `node Clipchamp_Bunny\tools\deploy-ledger-reclaim.mjs reclaim-stale`.

## One deploy at a time

Two agents building and installing at the same time is how a half-written
executable ends up in the install folder. The engine therefore takes the
**same file lock** the classic path uses:

```
%LOCALAPPDATA%\T9EditorLIT\deploy\deploy.lock
```

It is held across the whole build _and_ install, and released in a
`finally`, so a failed deploy does not leave it locked.

The build folder itself stays **shared** on purpose: an isolated folder per
work order stops two builds from touching the same files, but it also
throws away the dependency cache, and every build then costs the full five
minutes instead of one. The deploy lock is what serialises the work.

## What a failure leaves behind

A failed deploy closes its queue slot with `failed` and the real error, so
the next agent is not left waiting on a lease nobody will release.

## When an agent dies mid-deploy

Two kinds of leftover, and both of them block the queue:

| State    | What it means                            | How to clear it                                                                                                                       |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `queued` | the agent never claimed the slot         | the ledger's queued TTL (15 min) expires it; `node Clipchamp_Bunny\tools\deploy-ledger-reclaim.mjs reclaim-stale` can clear it sooner |
| `active` | the agent claimed the slot and then died | `node Clipchamp_Bunny\tools\deploy-ledger-restore.mjs release --id WO-...`                                                            |

The second one is the nastier of the two: an `active` order holds the only
deploy slot, and only the _first_ order in the queue can take it, so
everyone waits until the lease runs out on its own.
