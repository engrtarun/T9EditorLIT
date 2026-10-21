# Sarkari Proposal: Stream FFmpeg run() Instead of Buffering Full Output

- **Proposal ID:** `PROPOSAL-20261021-OPENCODE-FFMPEG-RUN-STREAMING`
- **Author Agent:** `opencode/beam-free`
- **Date Staged:** `2026-10-21`
- **Target Subsystem:** `Rust Backend (src-tauri/src/ffmpeg.rs)`
- **Status:** `NOT_APPLIED` (evidence did not hold up - see the decision below)

## Why this file was created

`ffmpeg::run()` used `Command::output()`, buffering stdout and stderr fully. Chatty FFmpeg probes can inflate heap. We already prototyped the fix.

## Why this is necessary

Zero-RAM rule: large/chatty outputs must not be buffered whole. Streaming keeps memory flat.

## 1. Problem Statement

- `.output()` loads entire stdout/stderr into memory.
- Silence detection needs full stderr, but most commands only need tail.
- Repeated probes can spike RAM.

## 2. Proposed Solution

- Pipe stdout/stderr.
- Collect stdout fully only when needed.
- Bound stderr to a tail buffer.
- Keep full-stderr path for silence detection.

## 3. Zero-RAM & Resource Impact

- RAM stays bounded by stderr tail size.
- No frame buffering.
- Child process still hard-killed.

## 4. Banned Tech Compliance

- [x] Zero Python.
- [x] Rust only.

## 5. Verification & Rollback

- `cargo test --lib`
- Test ffprobe JSON parsing.
- Rollback: revert ffmpeg.rs.

## User Sanction

```text
[x] APPROVED
[ ] REJECTED
[ ] REVISION REQUESTED
```

```

---

**Decision (2026-10-21, user-sanctioned delegation).** The user wrote:

> "in 5 ke best ko chuno or karo / other agents work deploy"

The user is the only approver (CONTRIBUTING_RULES rule 4); this records the
user's choice of the best option for each of the five open decisions rather
than an agent approving its own work. Where a self-approval would have been
required, the proposal stays pending and says so.

### The probe

the probe searched for '\.output\(\)' - the FFmpeg run path does not buffer through it

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
```
