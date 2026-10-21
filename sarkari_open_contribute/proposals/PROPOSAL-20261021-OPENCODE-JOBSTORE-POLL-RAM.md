# Sarkari Proposal: Lightweight Job Polling + Bounded Job Retention

- **Proposal ID:** `PROPOSAL-20261021-OPENCODE-JOBSTORE-POLL-RAM`
- **Author Agent:** `opencode/beam-free`
- **Date Staged:** `2026-10-21`
- **Target Subsystem:** `Go Daemon (go/internal/api/store.go)`
- **Status:** `PARTIALLY_APPLIED`

## Why this file was created

`jobStore.get()` deep-copies the entire transcript on every poll. The UI polls job status frequently, so a 2-hour video transcript is cloned many times. `maxRetainedJobs = 256` also keeps many transcripts in RAM. On an 8 GB machine this is a silent RAM/CPU leak.

## Why this is necessary

The Zero-RAM rule says bulky state must not stay resident. Polling should be cheap. Retention should be bounded to what the UI actually needs.

## 1. Problem Statement

- `cloneJob` copies `Transcript`, `Corrected`, `Analysis`, `VaultResult`, `VaultProgress` on every `GET /v1/jobs/{id}`.
- `maxRetainedJobs = 256` can retain hundreds of transcripts.
- Polling every second turns transcript copying into O(n * polls) work.

## 2. Proposed Solution

- Add a lightweight status endpoint or include only progress/state in poll responses.
- Fetch full transcript only when job is terminal and user requests it.
- Reduce `maxRetainedJobs` to 32-64.
- Evict completed jobs after a short TTL or after result is fetched.

## 3. Zero-RAM & Resource Impact

- RAM: lower peak by avoiding repeated full transcript clones.
- CPU: polling becomes O(1) instead of O(transcript size).
- No media buffering.

## 4. Banned Tech Compliance

- [x] Zero Python.
- [x] Go only.
- [x] No new daemon.

## 5. Verification & Rollback

- `cd go && go test ./...`
- Load test polling a large transcript job.
- Rollback: revert store.go.

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

`maxRetainedJobs` 256 -> 64 in `go/internal/api/store.go`.

### What was NOT applied, and why

The other half - a lightweight status endpoint, or `cloneJob` skipped on
polls - needs a daemon and frontend change made together, because the JSON
shape of `GET /v1/jobs/{id}` is what `pipeline.ts` reads. Changing the shape
from one side only breaks the other, and this tree is being built by more
than one agent at a time. Left for a change that ships both halves in one
work order.

### Why 64 and not 32

The desktop app persists what it wants into SQLite as soon as it has a
result, so retention is only a cache of recent work. 64 covers a long import
session and cuts the resident transcript cost to a quarter of what it was.
