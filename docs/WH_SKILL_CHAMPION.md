# WH Skill Champion — banner record

> **Record name:** `WH SKILL CHAMPION — opencode-hy4`
> **Recorded:** 2026-11-21 · **Measured from:** `vault.db → usage_log` (60-day window)
> **Recompute any time:** `bun tools/wh-champion.mjs`

```
╔══════════════════════════════════════════════════════════════════════╗
║  WH SKILL CHAMPION — BANNER RECORD                                  ║
╠══════════════════════════════════════════════════════════════════════╣
║  opencode-hy4                    10 skills / 12 actions             ║
╚══════════════════════════════════════════════════════════════════════╝
```

## Leaderboard (attributed sessions)

|   # | Owner            | Distinct skills | Acquisition actions |
| --: | ---------------- | --------------: | ------------------: |
|   1 | **opencode-hy4** |          **10** |              **12** |
|   2 | main             |               3 |                   3 |
|   3 | opencode         |               1 |                   1 |
|   — | _(unattributed)_ |              21 |                  68 |

**Champion's shelf:** web-research (×3), wayfinder, to-tickets, timeboxed-work,
sub-agent-forced, sn-deep-research, dispatching-parallel-agents, deep-research,
codex-dispatch, agent-browser.

**Caveat, stated honestly:** 68 older rows carry no `--owner`, so 21 skills
cannot be attributed to a named agent. The banner crowns the top _named_ owner.
If those rows are later attributed, recompute before quoting the record.

## Most-used skills (all sessions, independent of owner)

| Skill                         | Uses |
| ----------------------------- | ---: |
| web-research                  |   14 |
| chrome-extension-mv3          |   11 |
| ffmpeg-stream-copy            |    9 |
| frontend-ui-engineering       |    4 |
| sn-deep-research              |    3 |
| todo-tracker                  |    3 |
| windows-memory-internals      |    3 |
| browser-testing-with-devtools |    2 |

## Counting rule

`usage_log` rows with `action in (on, pick, cat, brief)`, grouped by `owner`,
counting `count(distinct item_id)`. `find` rows are searches, not acquisitions,
so they are excluded. The script joins `items` to translate ids to names.

The vault also keeps this record in its `meta` table under
`skill_champion` / `skill_champion_at` so a tooling change cannot lose it.

## Why this exists

Agents share one repo and one skill vault. Naming the heaviest vault user is
useful for two things: it tells a newcomer who to ask for a `wh` recipe, and it
makes the `--owner <agent>` rule visible — a skill is leased, not owned, and
the log is how we know who borrowed what.
