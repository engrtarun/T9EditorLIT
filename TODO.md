# TODO — Harry-style 60fps film + agent-proof system

_Last updated: 2026-11-21, after the measured-research round_

## What the user actually said

> "bro maja nahi aaya" — motion slow/boring, style galat, cuts nahi (ek hi take).
> Fix scope: **kam time + quality motion frames** (dono).

Then, on the research sprint: _"fayda banane me nahi h, use karne me h"_ — the
numbers only count once they change the film.

## 🔴 Now

- [ ] **v7 full render** — `render60.mjs`, 4572 frames, 1× raster + JPEG capture,
      running detached (log `out\v7-full.log`). Probe said 436 ms/f, actual
      ~227 ms/f → ETA ~16 min.
- [ ] Measure the finished film: `motion-report.mjs`. Gate: mean 1.0–3.0,
      cuts ≥ 1 per act boundary, ink ≥ 2%, contrast reported.
- [ ] Fill every PENDING row in `VERIFY.md` from this render.
- [ ] Watch it and decide whether "maja" arrived. Numbers can only tell you
      the frame is not empty; they cannot tell you it is good.

## ✅ Research sprint → what changed (5/5 answers in)

| Finding                                              | Applied                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Reference mean motion is **1.233**, not 2.75         | SKILL.md + never-do-this §J corrected; `motion-report` verdict rescaled (mean < 1.0 = frozen) |
| Reference beats every **2.5–3.0 s**; ours was 4.75 s | staged lines spread 0/0.45/0.9/1.35 s, annot at +1.6 s, `stamp` at ~2.6 s on 15 of 16 cards   |
| Reference ink **2.7 %**; ours 0.37 % → 1.91 %        | `cardScale` 1.35 → 1.48, `zoom` 1.4 → 1.46, act zoom spread                                   |
| A cut you cannot see measured **19.63** (cut = >20)  | act zoom ±9 % + per-act Y offset → cut now measures **20.48** and `cuts 1`                    |
| PNG capture was 772 ms/frame; `seek()` is 0.5 ms     | `--capture jpeg` q90 (SSIM 0.9959) → **207–264 ms/frame**                                     |
| 2× supersample buys nothing                          | measured 1× edge energy 4.190 vs 2× 4.174, SSIM 0.9948 → **1× is the default**                |
| `pushIn` 4.5 % was on in this project                | removed — the reference has no zoom at all, and per-frame `scale()` costs +340 ms/f           |

## ✅ System (the part other agents use)

- [x] `scripts/doctor.mjs` — environment self-check, names the broken thing
- [x] `scripts/smoke.mjs` — **scaffold → render 1 frame → assert it is the paper
      world** (YAVG 221.1, not black, not white). 15 s. Exit 1 on any break.
- [x] `scripts/motion-report.mjs` — mean/median/p90/max, **contrast (p90/median)**,
      **holds %**, cuts, moves, **ink coverage**, flattest 1 s windows
- [x] `scripts/render60.mjs` — JPEG capture + Edge flags by default, feel gate at
      the end, `--super` for an archival 2× master
- [x] `references/pacing-and-energy.md` — every measured number in one file
- [x] SKILL.md feel gate rewritten (the old table would have failed the
      reference itself), common-failure rows updated
- [x] Skill enabled in vault, leased to `owner=main`

## 🐛 Fixed this round

- [x] **`--edge-flags` silently became `true`** — `parseArgs` treats any next
      token starting with `--` as the next flag. CLI now takes bare names
      (`disable-partial-raster`); the env var still takes them with dashes.
- [x] **Render log lied** — printed "3840x2160 supersampled" while rendering 1×
- [x] **The cut was invisible** (position-only jump) — see the table above
- [x] **`pushIn` was still 0.045** in the film's content.js — the one setting
      that costs +340 ms/frame was live
- [x] 30-min timeout, probe start, floor detection, `file=` path, transform
      order, grain-at-encode (earlier rounds, still in place)

## 🟡 Next

- [ ] Preview file (720p30, first 20 s) for quick review — 3 min, not 16
- [ ] SFX pass (whoosh on cut, click on stamp) — the reference has audible cuts
- [ ] Beat-sheet generator: derive `enter` times from a Whisper transcript
      instead of hand-copying them

## 🟢 Later

- [ ] Install `iart-ai/explainer-video-skills` (MIT) — **needs explicit user approval**

## Blocked

- `websearch` returns HTTP 402 — use `webfetch`
- Image read tool returns a stale/cached image — QA must use numbers, not eyes
