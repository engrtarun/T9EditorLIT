# Sarkari Proposal: Reduce Per-Poll HTTP Request Logging

- **Proposal ID:** `PROPOSAL-20261021-OPENCODE-HTTP-POLL-LOG-SPAM`
- **Author Agent:** `opencode/beam-free`
- **Date Staged:** `2026-10-21`
- **Target Subsystem:** `Go Daemon (go/internal/api/server.go)`
- **Status:** `APPROVED_AND_APPLIED`

## Why this file was created

Every request is logged at Info level, including frequent job polls. This adds disk I/O and CPU overhead on a low-end machine.

## Why this is necessary

Polling is expected traffic. Logging it as Info creates noise and hides real issues.

## 1. Problem Statement

- `ServeHTTP` logs method/path/status/duration for every request.
- UI polls job status repeatedly.
- Log volume grows during long jobs.

## 2. Proposed Solution

- Log polls at Debug level.
- Keep Info for state-changing requests.
- Sample or aggregate poll logs.
- Add a separate metrics counter instead of per-request logs.

## 3. Zero-RAM & Resource Impact

- No memory increase.
- Lower disk I/O.
- Cleaner operator logs.

## 4. Banned Tech Compliance

- [x] Zero Python.
- [x] Go only.

## 5. Verification & Rollback

- `cd go && go test ./...`
- Check log volume before/after.
- Rollback: revert ServeHTTP logging.

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

### What was applied

`go/internal/api/server.go` logs `GET /v1/jobs/*` at `Debug`; every other
request stays at `Info` exactly as before.

### Why it was worth doing

`pipeline.ts` `waitJob()` polls `GET /v1/jobs/{id}` every 900ms, up to 600
times per job. Those were 600 `Info` log lines per import, each one a disk
write on a machine running at ~1 GB free - and every warning an operator
needs was drowned in them.
