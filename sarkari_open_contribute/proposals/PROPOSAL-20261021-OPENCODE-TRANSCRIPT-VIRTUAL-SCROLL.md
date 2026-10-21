# Sarkari Proposal: Virtualize Transcript List in Cut Panel

- **Proposal ID:** `PROPOSAL-20261021-OPENCODE-TRANSCRIPT-VIRTUAL-SCROLL`
- **Author Agent:** `opencode/beam-free`
- **Date Staged:** `2026-10-21`
- **Target Subsystem:** `Frontend UI (Clipchamp_Bunny/src/lib/components/cut/TranscriptPanel.svelte)`
- **Status:** `NOT_APPLIED` (evidence did not hold up - see the decision below)

## Why this file was created

A 2-hour tutorial can have thousands of transcript lines. Rendering all rows in the DOM increases memory and slows scrolling.

## Why this is necessary

Mode isolation keeps RAM flat, but DOM nodes also cost memory. Virtual scroll keeps only visible rows mounted.

## 1. Problem Statement

- Transcript panel may render large arrays.
- Scrolling becomes slow.
- Memory grows with line count.

## 2. Proposed Solution

- Render only viewport rows plus overscan.
- Recycle row components.
- Keep full array in store, not DOM.

## 3. Zero-RAM & Resource Impact

- DOM memory bounded.
- Smoother scrolling.
- No media buffering.

## 4. Banned Tech Compliance

- [x] Zero Python.
- [x] Svelte 5 only.

## 5. Verification & Rollback

- `npm run check`
- Test with 5000-line mock transcript.
- Rollback: revert component.

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

### The probe

the probe matched the bare word 'virtual', which is an ordinary English word - a false positive, not evidence

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
