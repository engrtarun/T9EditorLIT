# Sarkari Proposal: Stream Vault Hashing and Improve Upload Throughput

- **Proposal ID:** `PROPOSAL-20261021-OPENCODE-VAULT-UPLOAD-THROUGHPUT`
- **Author Agent:** `opencode/beam-free`
- **Date Staged:** `2026-10-21`
- **Target Subsystem:** `Go Daemon (go/internal/vault/telegram.go, vault.go)`
- **Status:** `NOT_APPLIED` (evidence did not hold up - see the decision below)

## Why this file was created

Vault uploads are multi-GB. Hashing and uploading whole parts can stall on an i3 machine and waste RAM if buffers grow.

## Why this is necessary

Telegram vault is a core feature. It must stream data and hash in chunks without loading parts into memory.

## 1. Problem Statement

- Large part files are hashed/uploaded.
- Buffering risks RAM spikes.
- Progress reporting needs byte-level updates.

## 2. Proposed Solution

- Stream file in fixed chunks.
- Hash incrementally.
- Reuse MTProto connection pool.
- Report bytes, not parts only.

## 3. Zero-RAM & Resource Impact

- Constant memory regardless of file size.
- Disk streaming only.
- No full part buffering.

## 4. Banned Tech Compliance

- [x] Zero Python.
- [x] Go only.

## 5. Verification & Rollback

- `cd go && go test ./...`
- Test upload progress on large file.
- Rollback: revert vault code.

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

the probe searched for 'io\.ReadAll' - the upload path does not read the whole file that way

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
