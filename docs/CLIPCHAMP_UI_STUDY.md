# Clipchamp UI — deep study of the editor screen

**Source:** one user-supplied screenshot of the Clipchamp **editor** (Windows
app / web, maximised 1920×1080), open on a project named _Video Project 2_
with a single imported clip (_Tamma Tamma (Lyrical) Dhurandha…_, 4:18).

**Why this exists:** T9EditorLIT is _inspired by_ Clipchamp, not a copy of it —
the timeline is deliberately different (it is the master: a cut is a red block,
never a deletion). This note records what Clipchamp actually looks like on one
real screen so future UI work can borrow the **shapes and rhythms** without
guessing. Measurements below are read off the capture with a ruler, so treat
±10 px as noise; the structure and ratios are the finding, not the last pixel.

Companion evidence (not from this screenshot): `docs/clipchamp-ref/` holds REA
captures — screenshots + full accessibility trees of the real app — indexed by
[`CLIPCHAMP_REA_REFERENCE.md`](CLIPCHAMP_REA_REFERENCE.md). This study covers
what an a11y tree does **not** show: what the screen looks like.

---

## 1. Anatomy — six zones

```
┌──────────────────────────────────────────────────────────────────────┐
│ ① global top bar                                        h ≈ 60 px   │
├────┬─────────────────┬───────────────────────────────────────────────┤
│②   │ ③ media panel   │ ④ editor column                              │
│rail│   w ≈ 322 px    │  toolbar · preview · transport · ruler        │
│88px│                 │                                               │
│    │                 ├───────────────────────────────────────────────┤
│    │                 │ ⑤ tracks (text / video / audio)               │
│    │                 ├───────────────────────────────────────────────┤
│    │                 │ ⑥ zoom controls + horizontal scrollbar        │
└────┴─────────────────┴───────────────────────────────────────────────┘
```

| #   | Zone             | Extent (px)        | What lives there                                                                                                                                                                                                                |
| --- | ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | Global top bar   | y 0–60, full width | Clipchamp logo + wordmark (x≈25–160), project-name dropdown pill (_Video Project 2 ▾_, x≈188–370), cloud/auto-save icon (x≈395); right side: _Buy Microsoft 365_ pill, contacts, gear, `?`, avatar, then the OS window buttons  |
| ②   | Left rail        | x 0–88             | Vertical icon-over-label nav, 11 px labels, ~24 px icons: **My media** (active — a thin purple indicator on the rail's left edge), Record & create, Content library, Templates, Text, Transitions, …                            |
| ③   | _My media_ panel | x 88–410 (w ≈ 322) | Header _My media_ + panel-collapse icon at its right; **Import media** split button (purple body + chevron arm); a media card: thumbnail, duration badge bottom-left (`4:18`), file name below, white check badge when selected |
| ④   | Editor toolbar   | y ≈ 70–110         | **left:** undo, redo · **dead centre:** `Size ▾` pill (crop glyph + label + ratio-less chevron), a brush/brand icon, a record icon · **right:** `Share ▾` (dark pill), `Export ↑` (purple)                                      |
| ④   | Preview stage    | y ≈ 118–670        | 16:9 video centred with black letterbox on every side (no frame, no border, no card), fullscreen glyph tucked bottom-right **inside** the stage                                                                                 |
| ④   | Transport row    | y ≈ 735–765        | Left cluster: magic-wand (AI) + scissors (split). Centre cluster: `\|◀`, `↺5`, **big white play circle** (r ≈ 21 px, black triangle), `5↻`, then `0:34 / 4:18`                                                                  |
| ④   | Ruler            | y ≈ 775–800        | Time labels (`0`, `0:10`, `0:20`, …) with **small dots** between them — see §3                                                                                                                                                  |
| ⑤   | Tracks           | y ≈ 855–1005       | Three full-width lanes: **+ Add text**, the **video clip**, **+ Add audio** — see §4                                                                                                                                            |
| ⑥   | Bottom bar       | y ≈ 1013–1070      | Right: four circular buttons (zoom out, zoom in, fit-to-width, expand). Full-width horizontal scrollbar below the lanes (thumb pinned left when zoomed out)                                                                     |

---

## 2. Colour & type as seen

| Token          | Value (read off the capture) | Used for                                                                    |
| -------------- | ---------------------------- | --------------------------------------------------------------------------- |
| App background | `#0B0B0C`–`#111112`          | window, rail, letterbox                                                     |
| Panel surface  | `#17171A`–`#1C1C1F`          | media panel, toolbar pills                                                  |
| Hairline       | `#2A2A2E`                    | panel edges, dashed lane outlines                                           |
| Brand purple   | ≈ `#7A28FF`–`#8B5CF6`        | Import media, Export, active-rail indicator, logo gradient (purple→magenta) |
| Text primary   | `#E8E8E8`                    | labels                                                                      |
| Text muted     | `#9A9A9E`                    | ruler times, rail labels, wheel text                                        |

Type: Segoe-UI-like UI face. ~13 px on buttons, 11 px on rail labels,
9–10 px on ruler times. Only **one** purple button is lit at a time in the
capture (Export, because Import's card is already loaded) — the interface stays
grey until an action is _the_ action.

---

## 3. The ruler — labels + dots, no lines

This is the detail worth stealing, and the reason it reads calm:

- **Major ticks carry only a text label** — no vertical line under them.
- **Between two labels sit three dots** on the labels' own baseline. With
  labels every 10 s that is a dot every **2.5 s** (four equal intervals per
  label gap).
- Nothing in the ruler is full-height: no hairline ever crosses into the lane
  below, so the lanes keep their own silhouette.
- The **playhead** is the only vertical line: a white ~2 px rule with a
  rounded white **knob** (≈16×26 px) sitting in the ruler, and the rule runs
  down through every track to the scrollbar.

Our timeline ruler used a full-height `w-px` line for **every** tick (minor and
major), which is a fence, not a ruler — `WaveTimeline.svelte` now draws a 3 px
dot for minors and keeps the label for majors, at `step / 4` so there are
exactly three dots between labels.

---

## 4. Lanes — empty state is an invitation

| Lane            | Treatment                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **+ Add text**  | dashed 1 px outline, full width, `T` glyph + muted label — always present, never a gap                                                                              |
| **Video clip**  | solid block, edge-to-edge **filmstrip** (repeated frames at their true aspect, ~72 px per cell), a speaker/mute glyph on the first cell, no rounded card, no shadow |
| **+ Add audio** | dashed outline like text, with the **real waveform drawn behind** the dashed border once audio exists                                                               |

Three fixed lanes, fixed order, always visible. Empty lanes are dashed
placeholders rather than removed rows, so the lanes never reflow — the mouse
always finds "+ Add audio" where it was.

_(T9EditorLIT already follows this: a dropped clip paints frames via
`ClipFilmstrip.svelte`, and the timeline never empties — a project with no
transcript still shows the source as blocks.)_

---

## 5. What this screen teaches, in one table

| Clipchamp does                                      | Why it works                                                 | T9EditorLIT                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Controls float with **no bar** under the top bar    | one surface, less chrome, more vertical room for the preview | ✔ the `Size / Share / Export` strip no longer draws `bg-nc-panel` + `border-b` (`PreviewBar.svelte`) |
| Ruler = labels + **dots**, playhead = the only line | lanes keep a clean silhouette                                | ✔ dots landed in `WaveTimeline.svelte`                                                               |
| One purple action, everything else grey             | the eye always knows the next step                           | partial — Export is `nc-brand`, rest muted                                                           |
| Letterboxed video, **no frame/card**                | the video is the hero, not the chrome                        | ✔ preview sits bare on the background                                                                |
| Fixed dashed lanes for text/audio                   | stable geometry, always-visible affordances                  | ✔ lane layout is fixed; red/grey cut blocks are _our_ addition                                       |
| Four circular zoom buttons at bottom-right          | zoom lives with the scrollbar, not in the toolbar            | ✔ zoom-fit lives in the bottom tool row                                                              |
| Filmstrip clip block with inline mute               | the block shows content, not a colour                        | ✔ (`ClipFilmstrip.svelte`)                                                                           |

**Deliberate differences (do not "fix" these to match Clipchamp):**

1. **The timeline is the master.** A cut becomes a permanent-looking **red
   block** (silence = grey) that never disappears — Clipchamp deletes and the
   gap closes silently. Restore + Undo bring it back; nothing is ever lost.
2. **The transcript is a first-class right panel** (Clipchamp's Captions is an
   add-on). Timeline ⇄ transcript sync is two-way and is the core feature.
3. **Per-clip mute, volume and duration labels** sit on the block itself.
4. **Applied ⇄ Raw preview toggle** — Clipchamp has no notion of playing the
   material you removed.

---

## 6. Limits of this study

- One static frame: hover states, menus, drag affordances, animations and dark
  vs light themes are **not** covered — the REA captures in
  `docs/clipchamp-ref/` (screens + a11y trees) are the source for structure and
  interactive names.
- Colour values are eyeballed from a compressed screenshot, not sampled from
  CSS; use them for _tone_, and `Clipchamp_Bunny/src/app.css` for the real
  tokens of our own theme.
- No claim is made about Clipchamp versions after the capture date (2026-10-27).
