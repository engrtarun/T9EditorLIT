# Agent workflow skills — wh reference

For agents on this machine: the "large work → subagents → web evidence →
tracked accounting → verified handoff" stack. All items below live in the
local vault (`C:\Users\pocot\.opencode\vault`) and are currently **ON**.

```powershell
$wh = "C:\Users\pocot\.opencode\vault\wh.ts"
bun $wh find "<keywords>"                 # discover
bun $wh cat <name>                         # read without enabling
bun $wh on <name> --owner <agent>          # lease it for your session
bun $wh off <name> --owner <agent>         # release when done
```

## The stack

| Need                           | Skill                         | Source                                                | What it enforces                                                                                                                                                                                                                         |
| ------------------------------ | ----------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time pressure                  | `timeboxed-work`              | GitHub `Gzh0821/timeboxed-work` @ `88b8846`           | bounded/stretch intent, soft/guarded/hard modes, must/should/could, isolated timers, finalization buffer, honest handoff. **Local PowerShell port** — no Python. See `docs/TIMEBOXED_WORK_REFERENCE.md`.                                 |
| "Should I delegate?"           | `codex-dispatch`              | GitHub `yinguangyao/codex-dispatch-skill` @ `00630de` | Mandatory visible decision `Dispatch: Direct \| Single \| Parallel \| Sequential` before the first child-work call. Hard delegation gates, max 3 children per decision, explicit child contract, no overlapping files, no grandchildren. |
| "Delegate everything + verify" | `sub-agent-forced`            | GitHub `float1122/sub-agent-forced` @ `f245e93`       | Main agent = orchestrator only. Decompose → dispatch → **verify one load-bearing fact yourself** (build/test/grep/read/diff) → report. Re-dispatch with the discrepancy when a claim fails your check.                                   |
| Web evidence                   | `web-research`                | local vault                                           | Decompose into 2–4 sub-questions, prefer primary sources, cross-check numbers, inline links + "what I could not verify". Uses built-in `websearch`/`webfetch` — no MCP.                                                                  |
| Parallel dispatch gate         | `dispatching-parallel-agents` | local vault                                           | Use when 2+ independent tasks have no shared state or sequential dependency.                                                                                                                                                             |
| Deep research → playbook       | `deep-research`               | GitHub `webcpu/deep-research-skill` @ `a70f438`       | Launches 3–5 parallel research agents from distinct angles (docs, practitioners, gotchas, ecosystem), then writes/updates a sourced markdown playbook. Pure markdown.                                                                    |
| Heavy deep research            | `sn-deep-research`            | local vault (Python)                                  | Multi-agent orchestration: quick / normal / heavy tiers, evidence JSON, review, perspectives, supplement research, citation rendering. Needs Python (3.14.5 available globally) and web search.                                          |
| Task accounting                | `todo-tracker`                | local vault                                           | Persistent `TODO.md`, add/done/list/summary. Use `TODO_FILE` to scope it to a task folder.                                                                                                                                               |
| Task breakdown                 | `to-tickets`                  | local vault                                           | Turns a plan/spec/conversation into tracer-bullet tickets with blocking edges.                                                                                                                                                           |
| Big multi-session work         | `wayfinder`                   | local vault                                           | Shared map of decision tickets, resolve one at a time.                                                                                                                                                                                   |

## Two delegation skills — how they coexist

They disagree by design, so use them by intent:

- **`codex-dispatch` is the default policy.** Start `Direct`; delegate only
  when a hard gate is met (context isolation, true parallelism, bounded
  implementation, hard debugging, independent review). Keeps coordination
  overhead honest and caps children at three.
- **`sub-agent-forced` is opt-in for "pure orchestration" tasks.** Its HARD
  RULE forbids the main agent from doing any real work directly. Trigger it
  when the user explicitly wants the whole job routed through subagents, e.g.
  _"sub-agent-forced se karo"_. Do not let its rule override normal small
  edits — it even forbids one-line fixes by the main agent.

Both agree on the important part: **a subagent's "done" is a claim, not a
fact** — verify it yourself before reporting success.

## Practical recipe for a large task

1. **Box it:** `pwsh -File ...\timebox.ps1 start "45m" --mode guarded --intent bounded --id <agent>-<task>` — write down the returned `deadline_at`.
2. **Decide dispatch:** emit `Dispatch: ... / Reason: ... / Children: ...` (`codex-dispatch`).
3. **Decompose + dispatch:** independent units in one parallel batch; dependent units sequenced. Each brief is self-contained with a definition of done and the verification command.
4. **Account:** add each unit to `TODO.md` via `todo-tracker`; mark `done` only after your own check.
5. **Web claims:** use `web-research` — `websearch` is HTTP 402 on this box, so fall back to direct `webfetch` of primary URLs.
6. **Verify:** for every unit, confirm at least one load-bearing fact yourself (`grep`, build, test, read file, diff, screenshot).
7. **Synthesise + hand off:** report what was verified, what was not, and the remaining scope. If the box expires, follow `timeboxed-work` handoff rules.

## Installed but OFF (need API keys)

| Skill                                    | Source                                            | Why off                                                                                                |
| ---------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `searchcans-deep-research` (+6 siblings) | GitHub `SearchCans/searchcans-skills` @ `32b5cbf` | Needs `SEARCHCANS_API_KEY` for SERP + Reader APIs. 7 skills installed; lease them once the key is set. |
| `firecrawl-*`                            | GitHub `firecrawl/skills`                         | Needs Firecrawl CLI + `FIRECRAWL_API_KEY`; not installed here yet.                                     |

Also in the vault but off: `sn-deepresearch-cli` (needs an API key and installs
a CLI) — skip unless explicitly requested.

## Caveats

- `deep-research` (webcpu) hardcodes `subagent_type: general-purpose` and
  `run_in_background: false` (Claude Code terms). On OpenCode map to the
  `general` subagent; run them in one parallel batch yourself.
- `sn-deep-research` is Chinese, large, and requires tier-1 web search to be
  ready. On this box `websearch` returns HTTP 402, so it will pause at its
  capability check until web search is configured — direct `webfetch` of
  primary URLs is the working fallback.
- Python 3.14.5 lives at
  `C:\Users\pocot\AppData\Local\Programs\Python\Python314\python.exe`;
  `GEMINI_API_KEY` is set. No `SN_API_KEY` / `FIRECRAWL_API_KEY` /
  `SEARCHCANS_API_KEY`.
- `sub-agent-forced` SKILL.md contains Korean sections and a strict "no direct
  work" rule — read it before leaning on it (`bun $wh cat sub-agent-forced`).
- `codex-dispatch` names Codex-style agents (`luna-explorer`, `terra-worker`,
  `terra-debugger`, `sol-reviewer`); on OpenCode map these to the available
  `explore` / `general` subagents, keeping the _decision_ framework intact.
- Neither skill installs anything or needs Python; both are pure markdown.
- `wh update <pack>` re-downloads upstream — the `timeboxed-work` PowerShell
  port must be re-applied after an update (see its reference doc).
