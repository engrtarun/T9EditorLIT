# Sarkari Proposal: Reduce Memory Probe Full Process Scan Frequency

- **Proposal ID:** `PROPOSAL-20261021-OPENCODE-MEMORY-PROBE-SCAN`
- **Author Agent:** `opencode/beam-free`
- **Date Staged:** `2026-10-21`
- **Target Subsystem:** `Rust Backend (src-tauri/src/memory.rs)`
- **Status:** `NOT_APPLIED` (evidence did not hold up - see the decision below)

## Why this file was created

MemoryProbe does a full process scan every 8 samples. On an i3, enumerating all processes costs time and CPU.

## Why this is necessary

The RAM meter should be cheap. Full scans should be rare and only when app tree changes.

## 1. Problem Statement

- Full scan every ~12 seconds.
- Iterates all OS processes.
- Adds CPU overhead on idle.

## 2. Proposed Solution

- Increase interval to 16 or 32 samples.
- Use cached process tree between scans.
- Only full scan when tree empty or new child suspected.

## 3. Zero-RAM & Resource Impact

- Lower CPU overhead.
- Same RAM accuracy.
- No new allocation.

## 4. Banned Tech Compliance

- [x] Zero Python.
- [x] Rust only.

## 5. Verification & Rollback

- `npm run verify:fast`
- Unit test sample timing.
- Rollback: revert memory.rs.

## User Sanction

```text
[x] APPROVED
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

### The probe

the probe searched for '% 8 == 0' - no such arithmetic in the memory probe

### Why it was not applied

The proposal's own probe is the evidence against it. The draft check
(`drafts/Check-10BigProblems.ps1`) looked for the pattern this fix is
supposed to remove and **did not find it**:

- the code is either already fixed, or
- the probe is looking in the wrong place.

Both cases lead to the same action: approving it now would either change
nothing (the work is already done) or change code on the strength of a
pattern that never matched. Neither is a fix.

### What would change the answer

A reproduction. Name the file, the function, the line, and what "too much
memory" looks like there - a measurement, not a suspicion. With that, the
proposal can be applied in a work order that ships something.

### Not a rejection of the idea

The idea is sound. This is "not now, and here is what 'now' would look
like" - and the section above says exactly that.
