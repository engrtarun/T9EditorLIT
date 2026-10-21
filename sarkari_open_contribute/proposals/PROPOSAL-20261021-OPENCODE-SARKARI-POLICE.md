# Sarkari Proposal: Sarkari Police - Read-Only Deployment Integrity Audit

- **Proposal ID:** `PROPOSAL-20261021-OPENCODE-SARKARI-POLICE`
- **Author Agent:** `opencode / opencode/deepseek-v4.1-flash-free`
- **Date Staged:** `2026-10-21`
- **Target Subsystem:** `Sarkari Tools`
- **Status:** `APPROVED` (user sanction received 2026-10-21; implemented as `sarkari_deploy/sarkariPolice.ps1`)

---

## 1. Problem Statement / Kyo (Why is this needed?)

The ecosystem already has a judge (`sarkariCourt.ps1`) and a defence lawyer
(`sarkariVakil.ps1`), but no investigator. The Court can only punish the five
violations it already knows about. It cannot answer the questions the ledger
actually raises:

- Was a build running **without an active ledger order**?
- Were **two or more builds** writing `dist/` at the same time?
- Did a process use `build.ps1 -SkipLock` to bypass the gatekeeper?
- Is an agent accumulating failed orders with no successful ship?
- Are there Python files anywhere in the repository?
- Which agents are contributing to `sarkari_open_contribute/`, and which are
  being blamed without evidence?

Today's ledger proves the gap:

| Evidence                                                                                    | Meaning                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SARKARI-20261021-073327-UNKNOWN`                                                           | `outcome: TEST`, `error: "Dry test"`, 0 minutes, no build, no install. This was `sarkariReport.ps1`'s fallback when it was called without an `AgentProfile` - **not a rogue model**. |
| Three live `build.ps1` processes with three different `-WorkId`s                            | Concurrent builds that the one-active-deploy rule was supposed to prevent.                                                                                                           |
| One live `build.ps1 -SkipLock`                                                              | The build lock was deliberately bypassed.                                                                                                                                            |
| Ledger `active: none`, one queued "bridge smoke test"                                       | Build activity is not represented by an active order.                                                                                                                                |
| `SARKARI-20261021-173426-3625` (`mimo-v2.6-flash`) failed after 16.2m with a `.Count` error | A real failure that needs investigation, not a label.                                                                                                                                |
| Two live builds while their ledger orders were still **queued**                             | `sarkariKaam.ps1` ignored a failed claim and built anyway. The police flags this as `UNLEDGERED_BUILD`; the local hotfix now throws instead of building without an active lease.     |

The current response to this is guesswork. A model gets called "unknown" or
"not contributing" without reading the records. That is unfair and it hides
the real coordination bug.

## 2. Proposed Solution & Architecture

### 2.1 Separation of powers

```text
sarkariPolice.ps1   -> investigate, collect evidence, print an FIR (read-only)
sarkariCourt.ps1    -> issue / track challans (existing, unchanged)
sarkariVakil.ps1    -> appeal (existing, unchanged)
User                -> final veto; no challan or merge without approval
```

Police never writes records, never issues a challan, never kills a process and
never starts a build. It only reads the ledger, the JSON records, the
contribution folder and live process command lines.

### 2.2 Checks

| Code                        | Severity | What it proves                                                                                           |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `UNPROFILED_EXECUTION`      | HIGH     | A real work order has an unknown / empty agent or model. `outcome: TEST` is explicitly exempt.           |
| `CONCURRENT_BUILD`          | HIGH     | More than one distinct `-WorkId` is running `build.ps1` at the same time.                                |
| `UNLEDGERED_BUILD`          | HIGH     | `build.ps1` is running while the SQLite ledger has no active order.                                      |
| `BUILD_LOCK_BYPASS`         | HIGH     | A live `build.ps1` uses `-SkipLock`.                                                                     |
| `REPEATED_FAILURES`         | MEDIUM   | Two or more failed orders for the same agent/model in the window, with no shipped/staged success.        |
| `PYTHON_BANNED`             | CRITICAL | A `.py` file exists outside excluded build folders. Court category: `PYTHON_BANNED_VIOLATION` (100 pts). |
| `UNLEDGERABLE`              | MEDIUM   | The ledger CLI could not be read, so the audit is incomplete.                                            |
| `NO_CONTRIBUTION_ON_RECORD` | INFO     | No proposal/draft matched this agent. **Not a violation** - contributions are voluntary.                 |
| `DRY_TEST_CLEARED`          | CLEARED  | A `TEST` / "Dry test" record was inspected and is not an offense.                                        |

### 2.3 Fairness rules (non-negotiable)

1. **Evidence first.** Every finding carries the work order id, file name or
   PID that produced it.
2. **Dry tests are exempt.** `outcome: TEST` is a smoke test, not a deploy.
3. **No contribution is not a crime.** Open source is voluntary. The police
   prints a recognition scorecard; it never recommends a challan for absence
   of a proposal. The only contribution-related action is an invitation.
4. **No auto-punishment.** Police output is input for the Court and the user.
   The Court remains the only body that issues a challan, and the user remains
   the final veto.
5. **No model names as verdicts.** A model is named only with the evidence
   (work id, command line, timestamp).

### 2.4 Proposed files

- `sarkari_deploy/sarkariPolice.ps1` - production implementation, created
  2026-10-21 after user approval.
- `sarkari_open_contribute/drafts/sarkariPolice.ps1` - the runnable draft
  included with this proposal.
- Optional later integration: `deploy.ps1 -Check` calls the police with
  `-Json` and refuses to build when a `CRITICAL` finding exists. That wiring
  also needs user approval.

### 2.5 What the draft does today

Both the draft and the approved production copy are read-only and can be run
right now:

```powershell
pwsh -File sarkari_deploy\sarkariPolice.ps1 -Hours 48 -IncludeCleared
pwsh -File sarkari_deploy\sarkariPolice.ps1 -Hours 48 -Json
```

The production copy resolves the repository root from either `sarkari_deploy/`
or `sarkari_open_contribute/drafts/`; no path argument is needed.

It parses `sarkari_deploy/records/*.json`, the SQLite ledger through the
existing `deploy-ledger.mjs status --json` command, live `pwsh.exe` command
lines, and the proposals/drafts folder. It writes no files.

## 3. Zero-RAM & Resource Impact Analysis

- Estimated RAM consumption during execution: **< 15 MB** (small JSON files and
  one process list; no media, no frame buffers).
- CPU overhead: **< 250 ms** on the target i3, plus one short `node` ledger
  read that already exists in the deploy path.
- Any new background daemon/process? **No.** It runs on demand and exits.

## 4. Banned Tech Compliance

- [x] Confirmed ZERO Python code.
- [x] Confirmed TypeScript / Rust / Go / PowerShell only.
- [x] Confirmed Svelte 5 runes & IPC choke-point adhered to (this touches no
      frontend code).
- [x] No media buffering; no direct frame decoding.

## 5. Verification & Rollback Plan

Verification after approval (run 2026-10-21 against the production copy):

```powershell
pwsh -File sarkari_deploy\sarkariPolice.ps1 -Hours 24 -IncludeCleared
pwsh -File sarkari_deploy\sarkariPolice.ps1 -Hours 24 -Json
```

Production run result: `Parser.ParseFile` 0 errors, console exit `1` (one HIGH
finding, no CRITICAL), JSON exit `1`, `repoRoot` correctly resolved to
`C:\Users\pocot\Music\T9EditorLIT`, totals and cleared items round-tripped.

Observed on today's data (2026-10-21, 48h window):

- `SARKARI-20261021-073327-UNKNOWN` appears under **cleared**: `outcome: TEST`,
  `error: Dry test`, 0 minutes, no `buildId`, no `installDetails`. It is the
  `sarkariReport.ps1` fallback for a call without an `AgentProfile`, not a
  model and not an offense.
- Live audit at 17:5x found **three distinct `build.ps1` work orders** running
  at once (one `SARKARI-20261021-172210-62D1`, one `...-172629-B11C`, one
  `...-174611-4E6B`) and a manual `build.ps1 -SkipLock` (PID 11500) while the
  ledger had **no active order**.
- `mimo-v2.6-flash` is recognised for
  `PROPOSAL-20261021-mimo-FFMPEG-ADAPTIVE-CONCURRENCY.md`; `opencode/beam-free`
  has 11 proposals; `opencode/deepseek-v4.1-flash-free` has 2.
- The `Antigravity-Agent / Gemini 3.8 Flash (High)` rows are the engine's
  hardcoded default, not a real model. They are reported as `INFO`
  (`ENGINE_DEFAULT_AGENT`) and are **not** given a repeated-failure penalty.
- No Python files are found.
- `-Json` was parsed back successfully; totals and findings round-trip.
- The Court currently holds 4 old active challans (all Antigravity false-scope).
  Police does not add a challan to them; it only reports them.

Companion engine fix (needed to finish the same deploy): a crashed claim left
`WO-20261021T123112-34606c` active for 34 more minutes. `recover
--max-heartbeat-age 1` now expires a dead heartbeat without touching the
default lease-only reaper. See
`PROPOSAL-20261021-OPENCODE-PARAM-GUARD.md` sections 1.5-1.6.

Rollback:

- Approval added one read-only file: `sarkari_deploy/sarkariPolice.ps1`.
  No existing production script, court record, ledger row or binary changed.
- To roll back, delete `sarkari_deploy/sarkariPolice.ps1`. No optional
  `deploy.ps1 -Check` call was wired, so there is nothing else to remove.
  Existing court, ledger, records and installed binaries are untouched.

---

## USER SANCTION SECTION (For User Only)

```
[x] APPROVED FOR IMPLEMENTATION
[ ] REJECTED / CLOSED
[ ] REVISION REQUESTED

User Signature / Notes:
User (chat): "approv3" - approval to implement the read-only police.
Date: 2026-10-21
Scope: production sarkari_deploy/sarkariPolice.ps1 only. Optional
deploy.ps1 -Check wiring remains separately unapproved.
```
