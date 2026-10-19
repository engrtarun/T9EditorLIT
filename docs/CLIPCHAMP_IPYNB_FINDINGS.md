# Clipchamp notebook — complete inventory

> Source of truth for every scrap of material handed over in
> `resource_Clipchamp/desing4use.ipynb` (and its continuation
> `desing4use_part2.ipynb`).
>
> **Why this file exists:** cell 19 of the notebook asks for exactly this —
> _"is .ipynb me kya kya mila wo ek md me likh dena taki tum koi kaam chori na
> kar sako"_ — so that no agent can quietly skip a piece of the material. If
> you are an agent picking this repo up, read this file **and** re-read
> `resource_Clipchamp/desing4use.ipynb` before touching the UI. The user drops
> new cells in between sessions; this document must be refreshed whenever the
> notebook grows.
>
> Related: [`CLIPCHAMP_REA_REFERENCE.md`](./CLIPCHAMP_REA_REFERENCE.md) holds
> the Fluent design tokens and the DOM test-id map extracted from the real app.

---

## 0. File map

| File                                                | What it is                                                                                                                                               |
| :-------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource_Clipchamp/desing4use.ipynb`               | **Primary material.** 21 cells. Re-read at the start of every session.                                                                                   |
| `resource_Clipchamp/desing4use_part2.ipynb`         | Continuation notebook — all _future_ material lands here (cell 20 of the main notebook). Currently a single marker cell: _"aab yaha se naya maal aage"_. |
| `resource_Clipchamp/desing.ipynb`                   | Older notebook (7 cells). History only.                                                                                                                  |
| `resource_Clipchamp/singleFiles/openclipchamp.html` | DOM capture: what Clipchamp shows **immediately after a project import**.                                                                                |
| `resource_Clipchamp/singleFiles/fileRenameer.html`  | DOM capture: the project-title dropdown (Rename / Open file location / Create a new video).                                                              |
| `resource_Clipchamp/singleFiles/cloudbtn.html`      | DOM capture: what happens when the cloud button is clicked.                                                                                              |
| `resource_Clipchamp/singleFiles/afterClickDP.html`  | DOM capture: the avatar / profile dropdown.                                                                                                              |
| `resource_Clipchamp/clipchamp_OBSrecord.mp4`        | Screen recording of a full Clipchamp session (cell 1).                                                                                                   |
| `resource_Clipchamp/NOT.mp4`                        | **Test video** (cell 19) — use this for all manual and automated checks.                                                                                 |
| `resource_Clipchamp/myneed3.jpg`                    | Early requirement sketch.                                                                                                                                |
| `resource_Clipchamp/clipchamp_test.html`            | The user's own dark-theme prototype; source of the chosen dark palette.                                                                                  |

Notebook attachment screenshots have been extracted to
`%TEMP%\opencode\cell{3,9,11,13,17}_image_png.png` for reference. Re-extract
with `node $env:TEMP\opencode\ccimg.cjs` if they are gone.

---

## 1. Cell-by-cell inventory (`desing4use.ipynb`)

|   # | Type | Content                                                                                                                                                                                        | Status                                                  |
| --: | :--- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------ |
|   0 | md   | _"yaha me maal dunga"_ — the notebook's opening marker.                                                                                                                                        | —                                                       |
|   1 | md   | Points at `clipchamp_OBSrecord.mp4`: _"samjh lo is video ko aab me deta hu … hamre tech stack me banan a … sabhi files ko smajhlo is project ki"_. Watch the recording, understand every file. | Understood                                              |
|   2 | md   | Points at `singleFiles/openclipchamp.html`: this is what Clipchamp shows the moment a project is imported. Announces DOM extraction.                                                           | Implemented                                             |
|   3 | md   | Screenshot: the project **rename** flow. _"aaba me shuru karte hu jaha se hum clipchamp me file rename etc sakte h"_                                                                           | Implemented                                             |
|   4 | code | 69 KB React capture of the imported-project screen, `ExtractedComponent.css` + JSX.                                                                                                            | Implemented                                             |
|   5 | md   | Points at `singleFiles/cloudbtn.html` — the cloud-button popover. Also: _"bhai mindset.md banao or waha aapna aapna vichaar likhao … ye tumhara exam h"_.                                      | Implemented (popover); `mindset.md` still outstanding   |
|   6 | md   | The avatar / profile dropdown (`afterClickDP.html`). Reserved for Telegram/MTProto, Gemini and Groq API options once the backend lands.                                                        | UI shell done; backend pending                          |
|   9 | md   | Screenshot: the **preview / stage** area.                                                                                                                                                      | Implemented                                             |
|  11 | md   | Screenshot: the **timeline** section with its `data-testid`s.                                                                                                                                  | Implemented                                             |
|  13 | md   | _"time line ke niche ek fuiToolbar h"_ + screenshot of the bottom-right timeline toolbar.                                                                                                      | **Implemented this session**                            |
|  14 | code | That toolbar's JSX: `fui-Toolbar` with four buttons.                                                                                                                                           | **Implemented this session**                            |
|  15 | code | The same collapse button in isolation (collapsed-timeline state).                                                                                                                              | **Implemented this session**                            |
|  16 | md   | _"jo tumne banaya h kya wo clipchamp se 90% similer h … screenshot lo or side by side compare karo"_ — the user wants a side-by-side screenshot comparison against real Clipchamp.             | **Outstanding — see §5**                                |
|  17 | md   | Screenshot: the **full-screen video preview**.                                                                                                                                                 | **Implemented this session**                            |
|  18 | code | 66 KB capture of the full-screen preview: transport bar + scrubber + captions + exit.                                                                                                          | **Implemented this session**                            |
|  19 | md   | _"bhai ye video do test me … `resource_Clipchamp\NOT.mp4`"_ + _"is .ipynb me kya kya mila wo ek md me likh dena"_.                                                                             | Test video registered; **this file is the deliverable** |
|  20 | md   | _"aab sara maal `desing4use_part2.ipynb` me aayga aab usko padhna"_.                                                                                                                           | Noted — check both notebooks every session              |

---

## 2. Extracted UI facts

### 2.1 Project-title dropdown (`fileRenameer.html`)

`fui-MenuPopover` → `fui-MenuList` (`max-width: 280px`) → `fui-MenuItem` rows,
popper placement `bottom-start`.

| Row                    | Detail                                                                                                                         |
| :--------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| **Rename**             | `data-testid="rename-button"`. Swaps the menu body for an inline text field.                                                   |
| **Open file location** | Two-line row (`align-items: start`) with a path subtitle rendered as `drives › CA2372DA03CE11C3 › root: › Videos › Clipchamp`. |
| _divider_              | `fui-MenuDivider`.                                                                                                             |
| **Create a new video** | Plus-in-circle glyph.                                                                                                          |

Measured popup transform in the capture: `translate3d(193.6px, 44px, 0px)`.

### 2.2 Timeline toolbar (cells 13–15)

`role="toolbar"`, docked bottom-right **below** the tracks. Four icon buttons,
in this order:

| `data-testid`              | `aria-label`      |
| :------------------------- | :---------------- |
| `toolbar-button-zoom-out`  | Zoom out timeline |
| `toolbar-button-zoom-in`   | Zoom in timeline  |
| `toolbar-button-zoom-fit`  | Fit timeline      |
| `button-collapse-timeline` | Collapse timeline |

Measured size in the screenshot: **129.6 × 33.2 px**.

### 2.3 Full-screen preview (cells 17–18)

An in-app overlay, _not_ a browser fullscreen. Black stage fills the window; a
transport bar runs along the bottom.

| `data-testid`     | `aria-label`                                |
| :---------------- | :------------------------------------------ |
| `toStart`         | Seek to start                               |
| `fastBackward`    | Seek back 5 seconds                         |
| `playPause`       | Play / Pause                                |
| `fastForward`     | Seek forward 5 seconds                      |
| `toEnd`           | Seek to end                                 |
| —                 | playback slider                             |
| —                 | current time `0:00` / total duration `0:36` |
| `show-captions`   | Show captions                               |
| `exit-fullscreen` | Exit full screen                            |

Also visible on the stage chrome: `aspect-ratio-preview`, `video-preview`,
`Stage media drop zone`.

### 2.4 My-media test-ids

`asset`, `asset-draggable`, `asset-title`, `in-use-checkmark`,
`add-asset-button`, `click-to-add`, `progress-bar`, `displayed-percentage`,
`More options` (aria-label).

### 2.5 Timeline test-ids

`tracks-container`, `empty-state`, `hide-button`, `track`, `video-track`,
`filmstrip`, `transition-*`, `+ Add text`, `+ Add audio`.

### 2.6 Timeline toolbar (from cell 13 screenshot)

`+ Add text` lane and `+ Add audio` lane (with waveform) sit under the video
track; each row has a mute toggle.

### 2.7 Top bar (from cell 13 screenshot)

Waffle → Clipchamp logo → project title with caret → cloud icon →
"Buy Microsoft 365" → share / apps / gear / help / avatar. The left rail in the
real app has **eight** items and no Cloud Vault or Settings — those two are
T9's own additions.

### 2.8 Dark palette (`clipchamp_test.html`)

```
--bg: #0c0c11   --bg2: #121219   --panel: #15151d   --panel2: #1b1b25
--line: #26262f --line2: #33333f --txt: #ececf2     --mut: #9a9aa8
--mut2: #6f6f7d --accent: #7c5cff --accent2: #8d6fff --accent-d: #6a48e6
--danger: #ff5a5a --ok: #3ddc84
```

Real Clipchamp Fluent values for reference: brand purple `#892FFF` /
`#7611F0` / `#6200D5`; neutrals `#232330` / `#404055` / `#5F5F77`; light
surfaces `#ffffff` / `#FAFAFF` / `#F5F5FA`.

---

## 3. Keyboard shortcuts (transcribed from Microsoft's own list)

Sources: support.microsoft.com _"Keyboard shortcuts for Clipchamp"_ and
clipchamp.com/en/blog/clipchamp-shortcuts.

Implemented in [`src/lib/stores/shortcuts.svelte.ts`](../src/lib/stores/shortcuts.svelte.ts);
the `Ctrl + /` cheat sheet is **generated from that same table**, so the sheet
cannot drift from what the app actually does.

| Group      | Shortcut                             | Action                                             |
| :--------- | :----------------------------------- | :------------------------------------------------- |
| General    | `Ctrl + /`                           | Open keyboard shortcuts                            |
|            | `Ctrl + Z`                           | Undo                                               |
|            | `Ctrl + Y` · `Ctrl + Shift + Z`      | Redo                                               |
|            | `Alt + I`                            | Go to import media                                 |
|            | `Alt + E`                            | Go to export                                       |
|            | `Alt + N`                            | Go to project name                                 |
|            | `Alt + R`                            | Go to aspect ratio selector                        |
|            | `Alt + H`                            | Go to help button                                  |
| Timeline   | `S`                                  | Split                                              |
|            | `Delete` / `Backspace`               | Delete                                             |
|            | `Ctrl + C` / `Ctrl + V` / `Ctrl + D` | Copy / Paste / Duplicate                           |
|            | `Ctrl + A`                           | Select all items                                   |
|            | `Ctrl + G` · `Ctrl + Shift + G`      | Group / Ungroup                                    |
|            | `Esc`                                | Deselect / close                                   |
| Playback   | `Space`                              | Play or pause                                      |
|            | `Ctrl + ←` / `Ctrl + →`              | Seek to start / end                                |
|            | `←` / `→`                            | Seek backward / forward                            |
|            | `Shift + ←` / `Shift + →`            | Seek backward / forward (larger)                   |
|            | `↑` / `↓`                            | Volume up / down                                   |
|            | `M`                                  | Mute / unmute                                      |
|            | `C`                                  | Show captions                                      |
|            | `F`                                  | Full-screen preview                                |
| Zoom & nav | `Ctrl + =` / `Ctrl + -` / `Ctrl + 0` | Zoom in / out / fit                                |
|            | `Alt + 1…5`                          | Rail · sidebar · timeline · stage · property panel |
| T9 only    | `Ctrl + 1` / `Ctrl + 2` / `Ctrl + 3` | Cut / Polish / Export mode                         |

Not yet implemented (no model for them yet): `X + ←/→/↑/↓` move-item, and
player-only `↑`/`↓` volume when the stage is not focused.

---

## 4. Features referenced by the notebook / the recordings

Implemented, partially implemented, or explicitly parked:

- Import media (native picker + OS drag & drop) — **done**
- Project rename / open location / create new video — **done**
- Timeline zoom (buttons, `Ctrl + -/=/0`, `Ctrl + wheel`) — **done**
- Collapse timeline — **done**
- Full-screen preview with transport bar — **done**
- Transcript-driven captions (`C`) — **done** (T9's own twist: captions come
  from the Whisper transcript, so there is no sidecar file to generate)
- Right-click asset context menu — **done**
- `Ctrl + /` cheat sheet — **done**
- Theme switch (Clipchamp dark / Nanami / Clipchamp light) — **done**
- Telegram cloud vault (MTProto, 1.9 GB chunking, 3–4 concurrent clients) —
  **backend pending**; the shell button and menu rows exist
- Gemini / Groq API options in the avatar menu — **backend pending**
- Auto-captions / text-to-speech / screen+webcam recorder / stock content
  library / templates / transitions / brand kit / green screen /
  picture-in-picture — **not started**; these are the real Clipchamp feature
  set listed on clipchamp.com/en/video-editor and are the obvious next tranche

---

## 5. Outstanding work

1. **Side-by-side comparison (cell 16).** Screenshot this app next to real
   Clipchamp and verify the "90% similar" claim, then close the 10% gap.
2. **`mindset.md` (cell 5).** Each agent writes down how it used the supplied
   resources — the user calls this an exam. Two agent folders exist:
   `Clipchamp_MIMO/` and `Clipchamp_Bunny/`.
3. **`+ Add text` / `+ Add audio` lanes** on the timeline (cell 11/13).
4. **Move-item shortcuts** `X + ←/→/↑/↓` (Microsoft's list, §3).
5. **Avatar menu backends** — Telegram/MTProto, Gemini, Groq (cell 6).
6. **Re-read `desing4use_part2.ipynb`** at the start of every session; new
   material now lands there (cell 20).

---

## 6. Hard constraints (AGENTS.md) that shape every UI decision

- **Zero RAM.** Nothing large is ever resident. Media is probed, chunked and
  cut through FFmpeg/FFprobe child processes, hard-killed when done; state
  lives in SQLite on disk. This is why drag & drop carries a **path**, never
  bytes, and why WebView2's `DataTransfer` (which hides file paths) is not
  used for OS drops — Tauri's `onDragDropEvent` is.
- **Mode-Based Panel Isolation.** `{#key}` destroys the outgoing tree. Every
  shortcut layer, drop listener and menu must therefore live **outside** those
  blocks or it dies on the next switch.
- **Layer boundaries.** Components may only call exports from
  `src/lib/ipc.ts`. `lib.rs` holds command declarations only.
- **Stack.** Svelte 5 runes + Tailwind 4 + Rust/Tauri v2 + the Go `t9cloud`
  daemon. No Python anywhere, no React, no heavy UI libraries.
- **Verify before hand-off:** `npm run verify:fast`.
