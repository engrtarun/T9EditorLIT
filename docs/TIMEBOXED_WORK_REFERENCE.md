# Timeboxed work — reference for agents

Skill for "agent ko time pressure ke saath kaam dena". Installed from GitHub
into the local vault, so any agent on this machine can pick it up.

| Field            | Value                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Vault item       | `timeboxed-work` (currently **ON**, global)                                               |
| Source           | `Gzh0821/timeboxed-work` — https://github.com/Gzh0821/timeboxed-work                      |
| Installed commit | `88b8846`                                                                                 |
| Local path       | `C:\Users\pocot\.opencode\vault\packs\timeboxed-work\skills\timeboxed-work\`              |
| Tags             | `powershell windows no-python deadline time-pressure timebox hard-deadline agent-timebox` |
| License          | Apache-2.0 (see `LICENSE` in the pack)                                                    |

## How an agent gets it from wh

```powershell
$wh = "C:\Users\pocot\.opencode\vault\wh.ts"
bun $wh find "time pressure deadline"   # discover
bun $wh cat timeboxed-work              # read full SKILL.md without enabling
bun $wh on timeboxed-work --owner <agent-name>    # enable for your session
bun $wh off timeboxed-work --owner <agent-name>   # give it back when done
```

The description triggers on: "work for N minutes/hours", "timebox", "hard
deadline", "use the full time / keep improving until the deadline", "stop at
18:30", "multiple agents with different budgets", "时间预算", "到点停止".

## What it enforces

- **Intent:** `bounded` (finish early when the task is done) vs `stretch` (keep
  doing useful low-risk work until the deadline).
- **Mode:** `soft` (default — time is a high-priority constraint, no command is
  killed), `guarded` (wrap only long commands), `hard` (only when the user says
  time is priority / must stop exactly on time).
- **Isolation:** every agent/session gets its own `timebox_id` and state file —
  parallel agents do not share a timer.
- **Scope control:** `must / should / could`; cut `could` first when behind.
- **Checkpoints:** `check` before each phase; `finalizing` status means no new
  broad changes; `expired` means stop and hand off.

## Quality guardrails — why a timebox does not mean a rushed job

The skill is built to protect a **small, verified core**, not to maximise
output per minute:

| Guardrail                    | What it does to quality                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `must / should / could` plan | The `must` is a _verifiable_ result. When behind, `could` is cut first, then `should` — the verified core is protected last.                                                                                  |
| Finalization buffer          | 1–2 min for boxes <10 min; otherwise `max(5 min, min(10 min, 10%))`. No new broad changes once `finalizing`; only validation, cleanup, handoff.                                                               |
| `bounded` intent (default)   | Stop when the useful task is done — do **not** fill remaining time with junk work. No padding, no fake activity.                                                                                              |
| `stretch` intent             | Only useful, low-risk work in a fixed order: correctness/edge cases → tests → real complexity cleanup → docs/handoff → small polish. Explicitly forbids inventing work and broad refactors near the deadline. |
| Checkpoints                  | Before each phase, compare progress to the plan; cut low-priority scope deliberately instead of rushing the core.                                                                                             |
| `soft` mode (default)        | Never kills a running command; at the deadline it stops starting new work and summarises. A test or build is not severed mid-run.                                                                             |
| Honest handoff               | On expiry it reports what is done, what is unverified and what remains — it does not silently disappear.                                                                                                      |

**The honest limit:** a timebox cannot create time. If the budget is shorter
than the `must` itself, something _will_ be handed off unfinished — the skill
makes that visible instead of pretending success. It also does not enforce your
project's own quality gates: put verification in the `must` explicitly, e.g.
"must = fix + `npm run check` + page renders", otherwise a time-pressured agent
may treat the check as `should`.

**What can actually hurt quality:**

- `hard` mode + `run_with_deadline.ps1` can terminate a wrapped child command
  mid-flight → partial artifacts and unverified state. Use `hard` only when the
  user explicitly says "must stop exactly on time", and wrap only long
  commands, never the verification step.
- Mis-declaring the budget: "15 min" with a 20-min `must` guarantees a handoff.
  State the scope honestly when you start the box.

**Recommended phrasing:** "15 minutes, soft/guarded, bounded intent. `must` =
the fix plus verification. If the `must` is not verified by the deadline, stop
and hand off with what remains — do not ship an unverified change."

## Commands (local PowerShell port — no Python)

The upstream skill ships Python scripts. **Python is banned in this repo**, so
the installed pack carries drop-in `.ps1` replacements and `SKILL.md` has been
patched to point at them. All examples use the `.ps1` scripts:

```powershell
$sk = "C:\Users\pocot\.opencode\vault\packs\timeboxed-work\skills\timeboxed-work\scripts"

# start a 15-minute box for one agent
pwsh -File "$sk\timebox.ps1" start "15m" --mode guarded --intent bounded --id agent-a
# check / summarise / clean up
pwsh -File "$sk\timebox.ps1" check --id agent-a
pwsh -File "$sk\timebox.ps1" summary --id agent-a
pwsh -File "$sk\timebox.ps1" cleanup --id agent-a

# wrap a long command (guarded or hard mode only)
pwsh -File "$sk\run_with_deadline.ps1" --state "<state_file>" -- node build.mjs
```

State lives in `%TEMP%\opencode\timebox\<id>\state.json` (override with
`$env:TIMEBOX_ROOT`). `start` returns JSON including an absolute `deadline_at`
and a `finalization_buffer_seconds` — use that, never estimate time from memory.

## Caveats

- The vault listing still shows `needs: python` — stale metadata from install
  time; the actual code is pure PowerShell. Tags above record the truth.
- `wh update timeboxed-work` re-downloads upstream and **wipes the `.ps1` port
  and the SKILL.md patch**. Re-apply them after any update.
- Not a hard real-time controller: `run_with_deadline.ps1` can only stop child
  processes it launched; host-level interruption needs an outer supervisor.
