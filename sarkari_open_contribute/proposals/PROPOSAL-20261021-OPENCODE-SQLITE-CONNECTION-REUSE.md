# Sarkari Proposal: Reuse SQLite Connections in Tauri Commands

- **Proposal ID:** `PROPOSAL-20261021-OPENCODE-SQLITE-CONNECTION-REUSE`
- **Author Agent:** `opencode/beam-free`
- **Date Staged:** `2026-10-21`
- **Target Subsystem:** `Rust Backend (src-tauri/src/lib.rs, transcript.rs)`
- **Status:** `REVISION_REQUESTED`

## Why this file was created

Many Tauri commands call `transcript::open_db` on every invocation. Repeated open/close adds latency and file handle churn on a low-end machine.

## Why this is necessary

SQLite is disk-backed state. Opening it once per app session is cheaper and safer than per-command opens.

## 1. Problem Statement

- `load_transcript`, `save_transcript`, `save_project`, etc. each open a new connection.
- Repeated open/close overhead.
- Potential lock contention during rapid UI actions.

## 2. Proposed Solution

- Store one SQLite connection in Tauri managed state.
- Initialize schema at app startup.
- Use mutex-guarded connection for commands.
- Keep WAL mode and busy_timeout.

## 3. Zero-RAM & Resource Impact

- One connection resident.
- Lower latency.
- No media buffering.

## 4. Banned Tech Compliance

- [x] Zero Python.
- [x] Rust only.
- [x] IPC choke point preserved.

## 5. Verification & Rollback

- `npm run verify:fast`
- Test rapid transcript save/load.
- Rollback: revert to per-command open_db.

## User Sanction

```text
[ ] APPROVED
[ ] REJECTED
[ ] REVISION REQUESTED
```

---

**Decision (2026-10-21, user-sanctioned delegation).** The user wrote:

> "in 5 ke best ko chuno or karo / other agents work deploy"

The user is the only approver (CONTRIBUTING_RULES rule 4); this records the
user's choice of the best option for each of the five open decisions rather
than an agent approving its own work. Where a self-approval would have been
required, the proposal stays pending and says so.

---

### Why it was not applied

Storing one `rusqlite::Connection` in Tauri managed state means wrapping it in
a `Mutex` and threading that lock through **13** `transcript::open_db` call
sites in a 47KB `lib.rs`. The gain is a few milliseconds per command - the
open is local disk with WAL - and the cost is a shared mutable handle that
every command now contends on, in the one file other agents are also editing.

A shared connection is a correctness-neutral optimisation being asked to
carry a real regression risk on a machine where builds already fail from
exhaustion. The narrower change that gets most of the safety without any of
the contention is to confirm `open_db` sets `busy_timeout` and WAL once, in
one place. That is the revision worth reviewing.
