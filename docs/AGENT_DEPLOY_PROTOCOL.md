# Agent Deploy Protocol — T9 Editor LIT

> **TL;DR (Hinglish):** Desktop app taskbar se chalta hai. Source change apne
> aap desktop pe nahi pahunchta. Har deploy pehle **SQLite ledger me work
> order** banata hai (agent, model, task, why, ETA, arrival/departure), phir
> build + install + verify karta hai. Sirf `shipped` status hi "done" hai.
> `"build chal raha hai"` ya `"baad me bata dunga"` ledger ke bina mat bolo.

This document is the contract for **every** agent that changes this repository:
the app/UI agent (`Clipchamp_Bunny/`) and the Go daemon agent (`go/`).

---

## 1. The one door

```text
source code
   │
   ▼
Clipchamp_Bunny/tools/deploy.ps1     ← the only supported deploy path
   │
   ├── work order in SQLite (agent, model, task, why, ETA, timestamps)
   ├── queue claim (one active deploy, fair FIFO + aging)
   ├── build.ps1 (frontend + Rust, build id, SHA-256 manifest)
   ├── install app (direct when closed, staged when running)
   ├── build/restart/stage the t9cloud daemon
   ├── write build.json marker
   ├── verify hashes, marker, /healthz, no foreign app instances
   ├── write evidence JSON
   └── ledger outcome: shipped | failed | cancelled
```

Entry points:

| Entry point                               | Use                                 |
| ----------------------------------------- | ----------------------------------- |
| `Deploy-T9EditorLIT.bat` (repo root)      | Double-click form, or pass switches |
| `Sarkari-Deploy.bat` (repo root)          | The fast-lane engine (see below)    |
| `Clipchamp_Bunny\tools\deploy.bat`        | Same, from the app folder           |
| `Clipchamp_Bunny\tools\deploy.ps1`        | The actual gate; agents call this   |
| `Clipchamp_Bunny\tools\deploy-status.bat` | Queue + recent work orders          |
| `Clipchamp_Bunny\tools\deploy-doctor.bat` | Read-only installed-state check     |

### 1a. The Sarkari fast lane (same door, faster)

`deploy.ps1` and `Deploy-T9EditorLIT.bat` are wired to the **Sarkari High-Speed
Engine** in `sarkari_deploy/`. It is the same door, not a second one:

| Switch      | What it does                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `-Check`    | **10-second fast check**: TypeScript + Svelte + Rust types. No build, no install. Use it before you burn a build. |
| `-Fast`     | Autonomous deploy with non-interactive defaults.                                                                  |
| `-Doctor`   | Installed-state check (exe, `.prev.exe` rollback shield, staged update, daemon health).                           |
| `-Status`   | Recent Sarkari orders.                                                                                            |
| `-Rollback` | Restore the previous stable build from `.prev.exe` by hand.                                                       |

Two things the Sarkari engine does **not** change:

1. **The queue is still the SQLite ledger.** The engine queues and claims the
   work order there (`sarkari_deploy/sarkariLedger.ps1`), so
   `deploy.ps1 -Status` still shows who is deploying right now and whose turn
   it is. A Sarkari deploy that did not reach the ledger would be a deploy
   nobody can wait for.
2. **The outcome is still `shipped` / `failed` / `cancelled`.** A failed deploy
   closes its queue slot too, so the next agent is not left waiting on a lease
   nobody will release.

`tools\build.ps1` exists, but it is a **build**, not a deploy. A build alone
does not reach the taskbar app and does not create a work order. Use it only
inside `deploy.ps1`, or for a throw-away build you will not ship.

---

## 2. Mandatory work-order form

Every deploy must answer these fields **before any build starts**:

| Field    | Switch        | Rule                                                             | Example                                                               |
| -------- | ------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Agent    | `-Agent`      | 2–64 chars, who is deploying                                     | `opencode`                                                            |
| Model    | `-Model`      | exact `provider/model` id, 3–120 chars                           | `opencode/deepseek-v4.1-flash-free`                                   |
| Task     | `-Task`       | 8–200 chars, what changes                                        | `fix the export button after a successful export`                     |
| Why      | `-Why`        | 12–2000 chars, why it matters                                    | `the button stays disabled, so the same cut cannot be exported twice` |
| ETA      | `-EtaMinutes` | 1–480, honest build+install+verify estimate, excludes queue wait | `25`                                                                  |
| Scope    | `-Scope`      | `app`, `go`, `both`, `docs`; default `app`                       | `both`                                                                |
| Priority | `-Priority`   | 0–100; default 50; above 60 needs `-Emergency`                   | `50`                                                                  |
| Session  | `-Session`    | optional; auto-generated when omitted                            | `S-opencode-20261020-2130`                                            |

Also recorded automatically:

- arrival time (`created_ms` / `enqueued_ms`), start time (`started_ms`),
  finish time (`finished_ms`)
- heartbeat time, lease deadline, phase, queue position
- git commit, branch, dirty flag, worktree, host, agent PID
- outcome, mode (`installed` / `staged`), build id, evidence path, errors

### 2a. Inline form (normal)

```powershell
cd C:\Users\pocot\Music\T9EditorLIT\Clipchamp_Bunny

pwsh -File tools\deploy.ps1 `
  -Agent "opencode" `
  -Model "opencode/deepseek-v4.1-flash-free" `
  -Task "fix the export button state after a successful export" `
  -Why "the button stays disabled, so the user cannot export the same cut twice" `
  -EtaMinutes 25 `
  -Scope both
```

For a Go-only change:

```powershell
pwsh -File tools\deploy.ps1 `
  -Agent "opencode" `
  -Model "opencode/deepseek-v4.1-flash-free" `
  -Task "stabilise the Telegram upload retry path" `
  -Why "a dropped socket currently loses the chunk instead of retrying it" `
  -EtaMinutes 15 `
  -Scope go
```

### 2b. Interactive form (human at the keyboard)

```powershell
pwsh -File tools\deploy.ps1 -Interactive
# or double-click Deploy-T9EditorLIT.bat
```

The interactive path asks the same questions, prints the order, and asks for
confirmation **before** creating it.

### 2c. Form file (automation)

Copy `Clipchamp_Bunny\tools\deploy-form.example.json`, fill it, then:

```powershell
pwsh -File tools\deploy.ps1 -FormFile .\my-deploy.json
```

A form file is just JSON. Command-line switches win when both are present.

### 2d. Environment variables

`deploy.ps1` reads these as defaults, so a harness can inject identity:

```text
T9_AGENT, T9_MODEL, T9_SESSION, T9_TASK, T9_WHY
OPENCODE_MODEL, OPENCODE_MODEL_ID   (model fallback)
```

The model id must be the real one the runtime reports — do not invent a
friendly name. The ledger is used to compare ETA accuracy per agent/model.

---

## 3. Queue rules (fair for both agents)

There is exactly **one active deploy** at a time, enforced by a partial unique
index in SQLite, not by a polite convention.

- Normal work is **FIFO** after effective priority.
- Default priority is **50**.
- Priority **ages +1 per minute waited**, capped at **+50**. A low-priority
  order cannot be starved forever by a stream of high-priority ones.
- Priority above **60** requires `-Emergency`; the switch raises it to at
  least **90**. Use it only for a real outage, not to jump the queue.
- A queued order with no heartbeat for **15 minutes** expires.
- An active order has a **lease** (`max(10, min(90, ETA + 15))` minutes). A
  child Node process heartbeats every **20 seconds**. If the agent process
  dies, the lease expires and the next order can run.
- The deploy also holds a file lock (`deploy.lock`) across build+install, so a
  second deploy cannot interleave file copies even if the ledger is bypassed.
- `-NoWait` cancels instead of waiting. `-MaxWaitMinutes N` caps the queue
  wait. The default cap is `max(10, min(180, ETA + 30))`.

While waiting, `deploy.ps1` prints:

```text
[queue] position 2/3, about 18.5 min of work ahead | active: WO-... opencode / model - task
```

That estimate is the sum of the ETAs ahead of you plus the remaining ETA of the
active order. It is an estimate, not a promise.

---

## 4. What the deploy actually does

### 4.1 Build

`build.ps1`:

1. Takes the build lock (`<target>\.build-lock`) so two builds cannot mix
   `dist/` and Rust output.
2. Runs `npm run build` and stops if the frontend fails — a stale `dist/` must
   never be embedded.
3. Runs `npx tauri build --no-bundle`, with up to 3 attempts for the fragile
   Windows link step.
4. Computes the executable SHA-256 and writes a manifest to:
   - `%LOCALAPPDATA%\T9EditorLIT\deploy\builds\<buildId>.json`
   - `%LOCALAPPDATA%\T9EditorLIT\deploy\builds\latest.json`
   - `<target>\release\build-manifest.json`

`T9_TARGET_DIR` is supported. If an agent builds in an isolated target, the
central manifest still points at the real executable, and `deploy.ps1`
installs **that exact file with that exact hash** — never “whatever is in
`target\release`”.

The build id is compiled into the app (`T9_BUILD_ID` → `build.rs` →
`lib.rs`) and passed to the Go linker (`-X .../api.Version=<id>`), so the
running app and daemon can prove which build they are.

### 4.2 App install

| Installed app | Result                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| not running   | new exe is installed in place; taskbar opens it                                                         |
| running       | new exe is staged as `t9-editor-lit.new.exe`; the app polls `build.json` every 5 s and shows **Update** |

Any app instance started from the repository (`target\release\...`) is closed:
the installed taskbar app is the only supported entry point. A running
installed app is never killed just to install.

Staged files are hash-checked before and after the move. A failed direct
install falls back to staging instead of leaving a half-installed folder.

### 4.3 Daemon install

`t9cloud` is rebuilt when Go sources changed (content hash of `go/**/*.go`,
`go.mod`, `go.sum` differs from the binary's `-version`). Then:

| Situation                | Result                                                                       |
| ------------------------ | ---------------------------------------------------------------------------- |
| daemon missing           | installed and started                                                        |
| daemon idle              | restarted immediately with the new binary                                    |
| daemon busy, app running | staged as `t9cloud.new.exe`; the app's Update click swaps it                 |
| daemon busy, app closed  | waits up to 90 s for the queue to drain, then **fails without killing work** |

The repository `.env` is copied to the install folder when it differs
(`.env.bak` keeps the previous one). The daemon listens on
`http://127.0.0.1:7878`; `/healthz` must report the build's version after a
restart.

### 4.4 Verification (must all pass)

- installed or staged app SHA-256 equals the build manifest hash
- `build.json` has the same `buildId`
- `build.json` carries the same `appSha256`
- no app instance is running from outside the install folder
- staged mode: `t9-editor-lit.new.exe` has the right hash and the installed
  app is running
- installed mode: live `t9-editor-lit.exe` has the right hash
- daemon live version equals the target version, or the staged daemon hash
  equals the target hash
- evidence file written to
  `%LOCALAPPDATA%\T9EditorLIT\deploy\evidence\<workId>.json`

Only after all checks does the ledger close as **`shipped`**.

### 4.5 Update button

The button appears **only** when `t9-editor-lit.new.exe` exists. It is not
triggered by a marker timestamp, a version string, or a hunch. Clicking it
runs the helper, swaps the app and a staged daemon, and restarts the app.
On the next launch the app rewrites `mode: staged` to `mode: installed` in
`build.json`, records `appliedAtUnix`, and keeps `stagedAt` as history (the
helper itself cannot edit JSON), so `-Doctor` never shows a staged marker with
no staged executable.

So:

- app was closed during deploy → no Update button is needed; the taskbar
  already opens the new build.
- app was running during deploy → the ledger says `shipped`, but the user
  still has to click **Update**. Say that explicitly; do not claim the UI is
  already showing the change.

---

## 5. Exit codes and outcomes

| Code | Meaning                                                                                   |
| ---- | ----------------------------------------------------------------------------------------- |
| `0`  | form valid and deploy shipped (or `-Status`/`-Doctor` passed)                             |
| `1`  | `-Doctor` found a broken install, or an unhandled launch/setup error                      |
| `2`  | form invalid (missing/short field, bad scope/priority, priority >60 without `-Emergency`) |
| `3`  | ledger rejected the work order (unknown id, bad token, wrong state)                       |
| `5`  | deploy failed after the work order existed; the ledger says `failed`                      |

Ledger outcomes:

- **`shipped`** — build installed/staged, hashes verified, evidence written.
- **`failed`** — an error was recorded with the work order and evidence path.
- **`cancelled`** — the agent chose not to wait, or cancelled interactively.
- **`expired`** — the agent vanished (queue TTL or lease expiry).

An agent that is blocked must close the order as `failed` with the real error.
Never leave an `active` order behind and walk away.

---

## 6. Status, ledger, proof

```powershell
cd C:\Users\pocot\Music\T9EditorLIT\Clipchamp_Bunny

pwsh -File tools\deploy.ps1 -Status
pwsh -File tools\deploy.ps1 -Doctor
pwsh -File tools\verify-install.ps1
```

The ledger lives at:

```text
%LOCALAPPDATA%\T9EditorLIT\deploy\ledger.db
```

Override it with `T9_LEDGER_DB` (tests use a temp file). Tables:

| Table         | Purpose                                                           |
| ------------- | ----------------------------------------------------------------- |
| `work_orders` | the form, queue state, timestamps, outcome, build/evidence        |
| `runs`        | one row per claim/attempt, with app/daemon hashes                 |
| `events`      | append-only phase log (requested, claimed, phase changes, finish) |
| `sessions`    | agent/model arrival, last seen, deploy count                      |
| `meta`        | schema version                                                    |

Other files:

```text
%LOCALAPPDATA%\T9EditorLIT\deploy\
  ledger.db
  deploy.lock
  builds\<buildId>.json, latest.json
  evidence\<workId>.json
  logs\deploy-*.log, t9cloud.out.log, t9cloud.err.log
```

The install folder:

```text
%LOCALAPPDATA%\Programs\T9EditorLIT\
  t9-editor-lit.exe
  t9-editor-lit.new.exe     (only while an update is staged)
  t9cloud.exe
  t9cloud.new.exe           (only while a daemon update is staged)
  .env
  build.json
```

`build.json` contains `buildId`, `builtAt`, `installedAt`, `stagedAt`, `mode`,
`appSha256`, `daemonBuildId`, `daemonSha256`, `daemonVersion`, `workId`,
`agent`, `model`, `scope`, git fields, and host. After the app applies a
staged update it adds `appliedAtUnix`; `mode` is then `installed` and
`stagedAt` remains as the last staging time.

---

## 7. Troubleshooting

| Symptom                                                   | What to do                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `the ledger did not return a work id`                     | Run `deploy.ps1 -Status`; check Node 22.5+ and `node:sqlite`                                                                                                                                                                 |
| `queue is busy` / `-NoWait`                               | Re-run without `-NoWait`, or wait; check the active order in status                                                                                                                                                          |
| `work order ... is expired`                               | The previous agent died; create a new request                                                                                                                                                                                |
| `the manifest points at a missing executable`             | The build folder was cleaned; run without `-SkipBuild`                                                                                                                                                                       |
| `the build is from commit ..., HEAD is ...`               | Rebuild, or use `-Force` only if you truly mean the older binary                                                                                                                                                             |
| `installed app hash mismatch`                             | Run `-Doctor`; do not hand-copy exes                                                                                                                                                                                         |
| `daemon did not answer /healthz`                          | Check `logs\t9cloud.err.log`, `.env`, port 7878                                                                                                                                                                              |
| `daemon still has N jobs in flight`                       | Wait for the queue; deploy refuses to kill work                                                                                                                                                                              |
| Update button not visible                                 | App must be running **and** `t9-editor-lit.new.exe` must exist; run `-Doctor`                                                                                                                                                |
| `non-installed app instance`                              | Close the repo `target\release` app; use the taskbar app                                                                                                                                                                     |
| Stale taskbar shortcut                                    | `pwsh -File tools\pin-taskbar.ps1` (deploy already runs it)                                                                                                                                                                  |
| A queued order nobody ever claimed                        | `node tools\deploy-ledger-reclaim.mjs reclaim-stale` (15-minute floor)                                                                                                                                                       |
| An order that was expired by mistake                      | `node tools\deploy-ledger-restore.mjs restore --id WO-...`                                                                                                                                                                   |
| An order stuck `active` after its agent died              | `node tools\deploy-ledger-restore.mjs release --id WO-...`                                                                                                                                                                   |
| `OUT_DIR env var is not set, do you have a build script?` | The package build folder was deleted without its fingerprint. `build.ps1` now removes both; if you hit this by hand, delete `src-tauri\target\release\.fingerprint\t9-editor-lit-*` too                                      |
| `Blocking waiting for file lock on build directory`       | Another build owns the shared target folder. **Do not run `cargo` by hand** — it bypasses the lock and the two builds delete each other's build folder. Use `tools\build.ps1`, or set `T9_TARGET_DIR` for an isolated folder |
| `link.exe` failed with `0xffffffff` / `LNK1181`           | Not enough free RAM for the link step (~1 GB). Close other apps, then re-run; the build script already retries                                                                                                               |

Diagnostics to attach to a bug report:

```powershell
pwsh -File tools\deploy.ps1 -Status
pwsh -File tools\deploy.ps1 -Doctor
Get-Content (Join-Path $env:LOCALAPPDATA 'T9EditorLIT\deploy\evidence\<workId>.json') -Raw
Get-Content (Join-Path $env:LOCALAPPDATA 'T9EditorLIT\deploy\logs\t9cloud.err.log') -Tail 100
```

---

## 8. Rules for agents (non-negotiable)

1. **Create the work order first.** No build/install before `request` returns a
   work id. `deploy.ps1` enforces this; do not bypass it.
2. **One deploy at a time.** The ledger and `deploy.lock` enforce it. Do not
   run a second `deploy.ps1`, `build.ps1`, or `tauri build` in parallel.
3. **Never start the repository exe as the user-facing app.** The installed
   copy is the only entry point. `-Dev` is for development only.
4. **Never hand-copy binaries into the install folder.** Use the manifest and
   the hash checks.
5. **Never kill the daemon while it has jobs in flight.** The deploy waits or
   stages; it does not destroy work.
6. **Never claim “build is running” without an `active` ledger order.** Status
   is `deploy.ps1 -Status`, not a chat message.
7. **Never say “I will notify you later” as a completion.** Close the order:
   `shipped`, `failed`, or `cancelled`.
8. **A staged deploy is not visible until the user clicks Update.** Say so.
9. **Python is banned.** Use PowerShell, Node `node:sqlite`, Rust, or Go.
10. **Do not edit `ledger.db` by hand.** Use the CLI in
    `tools\deploy-ledger.mjs`; it enforces tokens and state transitions.
11. **Never expire another agent's order.** A queued order with no run looks
    abandoned, but the agent that owns it may still be in its fast-check
    before it claims the slot. `tools\deploy-ledger-reclaim.mjs` refuses to
    touch anything younger than the queue's own TTL, for exactly this
    reason. If you expired an order by mistake, put it back with
    `tools\deploy-ledger-restore.mjs restore --id WO-...`.
12. **A dead order blocks the queue.** The claim only hands the slot to the
    order that is _first_ in line, so an order whose agent died stays at
    the front and nobody behind it can deploy. There are two shapes of it:
    - still `queued` → the ledger's queued TTL (15 minutes) expires it, and
      `tools\deploy-ledger-reclaim.mjs reclaim-stale` can clear it sooner;
    - already `active` with a lease nobody will release → release it with
      `tools\deploy-ledger-restore.mjs release --id WO-...`.

    If a deploy seems stuck with nobody active, check the head of the
    queue first: `deploy.ps1 -Status` shows the position.

### Agent checklist

```text
[ ] I know the exact model id my runtime reports.
[ ] My task and why are specific enough for a human to understand.
[ ] My ETA includes build + install + verify, not queue wait.
[ ] I chose the scope: app | go | both | docs.
[ ] I ran deploy.ps1 (not a bare build).
[ ] The ledger says shipped (or I recorded failed with the real error).
[ ] If staged, I told the user to click Update.
[ ] I ran deploy.ps1 -Doctor and it passes.
```

### What to tell the owner while you are waiting

The owner asked for a time and a reason, not "it is running in the
background". A chat message with no work order id in it is not a status -
it is a guess. The ledger already knows all of it, so read it and report it.

**When you are queued** (somebody else is deploying):

```text
Malik, mera deploy abhi queued hai, active nahi.

- Work order: WO-...
- Position: 4/4 (3 ahead)
- My agent/model: opencode / opencode/deepseek-v4.1-flash-free
- Task: ...
- Scope: both
- My ETA (build+install+verify): 12 min
- Estimated wait before my turn: ~34 min
  (3 ahead ke ETAs ka sum + active ka remaining)
- Ledger status: `deploy.ps1 -Status` (WO id upar hai)

Ye wait kam bhi ho sakta hai agar koi ahead wala jaldi finish ho.
Jab mera turn aayega, ledger "active" dikhayega aur main exact start
time bataunga.
```

**When you are active**:

```text
Malik, mera deploy abhi ACTIVE hai.

- Work order: WO-...   Run: RUN-...
- Agent/model: opencode / opencode/deepseek-v4.1-flash-free
- Task: ...   Scope: both
- ETA (maine darj kiya): 12 min
- Started at: 18:12:03
- Lease (deploy.ps1 allocated max wait): ~32 min
- Heartbeat: live (long build alive)
- Verify: `deploy.ps1 -Status` (WO id upar hai)
```

What is **not** acceptable: "background me chal raha hai", "baad me bata
dunga", or a wait estimate with no work order id next to it. The order id
is what makes the claim checkable.

---

## 9. Why this exists (the failure it fixes)

Before this gate:

- `deploy.ps1` could install “whatever is in `target\release`”, even when the
  agent had built into an isolated `T9_TARGET_DIR`.
- The root launcher started `Clipchamp_Bunny\src-tauri\target\release\...`
  instead of the installed exe. That process never read the installed
  `build.json`, so the Update button could never appear.
- There was no install lock, no hash proof, no queue, and no record of who
  changed what. An agent could say “build is running” and disappear.

Now the ledger is the only truth: if it does not say `shipped`, the desktop
does not have the change — no matter what a chat message says.

---

## 10. Related documents

- [`AGENTS.md`](../AGENTS.md) — repository rules, tech stack, banned tools
- [`Clipchamp_Bunny/docs/MEMORY.md`](../Clipchamp_Bunny/docs/MEMORY.md) — app
  architecture and gotchas
- [`docs/TELEGRAM_INTEGRATION_T_DUBBER.md`](TELEGRAM_INTEGRATION_T_DUBBER.md) —
  Telegram vault logic
