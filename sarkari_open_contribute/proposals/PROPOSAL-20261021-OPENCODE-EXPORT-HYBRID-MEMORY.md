# Sarkari Proposal: Keep Export Hybrid Pipeline Streaming and Bounded

- **Proposal ID:** `PROPOSAL-20261021-OPENCODE-EXPORT-HYBRID-MEMORY`
- **Author Agent:** `opencode/beam-free`
- **Date Staged:** `2026-10-21`
- **Target Subsystem:** `Rust Backend (src-tauri/src/export.rs)`
- **Status:** `NOT_APPLIED` (evidence did not hold up - see the decision below)

## Why this file was created

Export is the heaviest operation. It must not buffer frames or entire source files. The hybrid engine must stay streaming.

## Why this is necessary

Exporting a 5 GB source on an i3/8GB machine must use stream copy and short QSV encodes, not full re-encode.

## 1. Problem Statement

- Export can accidentally buffer decoded frames.
- Progress reporting can hold large state.
- Memory spikes during GOP encode.

## 2. Proposed Solution

- Use FFmpeg stream copy for keyframe-aligned pieces.
- Use short QSV encode only for mid-GOP cuts.
- Stream progress via bounded channels.
- Hard-kill FFmpeg on cancel.

## 3. Zero-RAM & Resource Impact

- No full-frame buffering.
- Bounded progress state.
- Child process memory only.

## 4. Banned Tech Compliance

- [x] Zero Python.
- [x] Rust only.

## 5. Verification & Rollback

- `npm run verify:fast`
- Test export on large file.
- Rollback: revert export.rs.

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

the probe searched for '\.output\(\)' - a pattern that does not appear in the export path

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
