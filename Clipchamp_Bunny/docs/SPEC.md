# SPEC — Nanami Cut ("No Overtime")

> Source of truth. Notebook (`resource_Clipchamp/desing.ipynb`) ka saara locked decision
> yahan freeze hai. Agar yahan kuch badalna ho, sirf yahan badlo — notebook dobara padhne ki zaroorat nahi.

---

## 1. Problem (why this app exists)

`@EngrTarunDilwal` style **2 ghante / 5 GB / 1080p-4K 60FPS** coding tutorials (Apna College,
Coder Army style) ke liye **fumble, repeat lines, lamba silence aur galat example** hatana hai.

Target machine: **Windows 11 · Intel i3 · 8 GB RAM (jismein ~80% already busy)**
Isliye **zero-RAM footprint** hi ek architectural constraint hai, ek optimisation nahi.

---

## 2. Locked tech stack

| Layer            | Technology                          | Rule |
| ---------------- | ----------------------------------- | ---- |
| Desktop shell    | Tauri v2                            | WebView2 reuse, no separate Chromium |
| UI               | Svelte 5 (runes) + TypeScript       | no React, no heavy component libs |
| Styling          | Tailwind CSS 4 (`@theme` tokens)    | v3 nahi |
| Core             | Rust (Tauri commands)               | pure logic in testable modules |
| Media            | FFmpeg / FFprobe **child processes** | kabhi in-RAM decode nahi |
| Local state      | SQLite on disk                      | transcript + cut decisions |
| Cloud AI         | Groq (Whisper) + Gemini             | transcript + fumble detection |
| Cloud daemon     | Go `t9cloud` on 127.0.0.1:8787      | Telegram MTProto vault + AI proxy |

### BANNED — poore repo me

- **Python** (no pip, no venv, no scripts) — hard ban
- Electron · Qt · C++ · React · Tailwind v3
- In-memory frame decoding / full-file buffering

---

## 3. Two-mode pipeline (the core idea)

Ek waqt me **sirf ek mode RAM me zinda** hota hai. Doosre ka component tree
`{#key}` se destroy/unmount hota hai. Mode switch = **hard memory drop**
(JS GC + Rust `drop()`).

| # | Mode      | Kaam | RAM me kya hai |
| - | --------- | ---- | -------------- |
| 1 | **MEDIA** | Import (file manager · link · Telegram · drop) → probe → **DEAD AIR** kaato | sirf library + dead-air workbench |
| 2 | **CUT**   | Transcript padho → ✕/✓ se fumble kaato → clips drag karke order badlo | yehi poora panel |

**Export** ek mode nahi — preview bar ke purple button se (Clipchamp jaisa).
Left rail me sirf **2** entries hain.

`POLISH` (text / zoom / music) **hata diya gaya** — app ka maksad silence
hatana aur transcript se edit karna hai, decoration nahi.

CUT mode me 90% kaam hota hai.

---

## 4. Mode 2 layout (tumhare diagram se, exact)

```
┌──────────────────────────────────────────────────────────────────┐
│ TOPBAR   logo │ project │ mode chips │ ⏱ Overtime Saved counter │
├────────────────────────────────┬─────────────────────────────────┤
│                                │  TRANSCRIPT PANEL               │
│      VIDEO PREVIEW             │  ┌───────────────────────────┐  │
│      (16:9 frame)              │  │ 0:12–0:14  "line text" ✓ ✕│  │
│                                │  │ 0:14–0:16  "next line" ✓ ✕│  │
│                                │  └───────────────────────────┘  │
│                                │  virtual scroll · auto-advance   │
├────────────────────────────────┴─────────────────────────────────┤
│ RULER  0:00   0:30   1:00   1:30   2:00                          │
│ ────────────────────────────────────────────────────────────────  │
│ AUDIO   ▁▃▅█▆▃▁ ▁▁▁ (gold=keep · red=fumble · grey=silence)       │
│ VIDEO   [fps thumbnails strip]                                    │
│ TEXT    [tutorial title / code zoom clips]                         │
└──────────────────────────────────────────────────────────────────┘
```

- Left box → video preview. Transcript line click = preview usi second pe jump.
- Right box → transcript, timestamps, ✓ / ✕ per line, virtual scrollbar.
- Bottom → audio waves + FPS thumbnail timeline (no text lane).

---

## 5. Cut model — "Phantom Cut"

5 GB video ko click pe **kat-te nahi**. Bas:

1. Line ka `keep` flag flip hota hai → SQLite me turant persist.
2. Line turant **red + slash** ho jaati hai (0.001 s feel).
3. Preview player us range ko **skip** kar deta hai.

Asli cutting sirf **Export** me, ek baar. Isi liye 5 GB edit "palak jhapak" me hota hai.

---

## 6. Keyboard (universal muscle memory)

| Key | Action |
| --- | ------ |
| `Space` / `K` | play / pause |
| `L` / `J` | forward 2x / rewind |
| `X` or `Delete` | ✕ cut current line → **auto-advance to next** |
| `V` or `Enter` | ✓ keep current line → **auto-advance** |
| `↑` / `↓` | prev / next transcript line (preview jumps too) |
| `Ctrl+B` / `S` / `C` | split at playhead (CapCut / Vegas / Premiere) |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |

**Flow:** `↓ X X X V ↓ V ↓ X` — pure keyboard, mouse zero. One-hand arcade flow.

---

## 7. Psychology / gamification

1. **Overtime Saved counter** — `Raw 1:52 → Final 1:18 · 34m cut`. Dopamine on every `✕`.
2. **Auto-advance** — no mouse travel between lines.
3. **Traffic-light waveform** — gold (keep) / red (fumble) / flat grey (silence). Eyes read it before ears hear it.
4. **Optimistic skeleton** — UI in 0.5 s, never a "please wait" screen. Waves stream in progressively.

---

## 8. Theme — T9 Editor LIT (branding board)

> Source: `Clipchamp_Bunny/T9 Editor LIT Branding Board.png` — "EDIT · CREATE · LIT".
> Legacy token names `--nc-*` rehne diye gaye hain (koi component edit nahi hua),
> sirf **values** branding board se hain. Primary accent = **blue** (gold nahi).

| Token | Value | Use |
| ----- | ----- | --- |
| `--nc-bg` | `#15171B` | app background (branding board "Background") |
| `--nc-panel` | `#1A1D24` | panels |
| `--nc-panel-2` | `#212530` | raised / hover |
| `--nc-line` | `#2B3040` | borders |
| `--nc-gold` | `#4D8DFF` | primary accent — buttons, active rail, keep (branding board "Primary Blue") |
| `--nc-gold-dim` | `#2F5FC0` | inactive accent |
| `--nc-red` | `#E5484D` | cut / fumble |
| `--nc-green` | `#3DD68C` | keep |
| `--nc-txt` | `#F5F7FA` | text (branding board "Text / Light") |
| `--nc-mut` | `#9AA3B5` | muted |

Branding rules (board ke DO's & DON'Ts): original high-quality assets use karo,
clear space maintain karo, colours na badlo, low-res versions na use karo,
extra elements/text na jodo.

---

## 9. Clipchamp DOM anatomy (from `singleFiles/afterClickDP.html`)

Clipchamp ke `data-testid` se poora component map nikla. Ye hamare component names ka
reference hai — naya UI banane se pehle yahan dekho:

| Area | Clipchamp test-ids |
| ---- | ------------------ |
| Top bar | `editor-nav` · `project-name-container` · `project-title-button` · `odsp-backup-button` (+`backup-icon-enabled`) · `premium-icon` · `help-and-support-button` · `me-control` |
| Left rail | `property-panel-button-media` · `-recordCreate` · `-discover` · `-templates` · `-text` · `-transitions` |
| Left panel | `drawer` · `sidebar-section` · `add-media` · `asset` · `asset-draggable` · `video-preview` · `progress-bar` · `displayed-percentage` · `add-asset-button` · `click-to-add` · `asset-title` · `in-use-checkmark` |
| Stage | `stage-button-undo` · `stage-button-redo` · `stage-canvas` · `aspect-ratio-preview` · `aspect-ratio-selector` · `global-toolbar-gradient-color-picker` · `enter-fullscreen` · `share-menu-button` · `button-export` |
| Timeline | `ai-suggestions-popover` · `toolbar-button-split` · `toStart` · `fastBackward` · `fastForward` · `timelinePlayPause` · `current-time` · `total-duration` · `timeline-ruler` · `seeker-container` · `seeker-stem` · `seeker-handle` · `timeline-scroll-container` · `tracks-container` |
| Lanes | `track` · `track-item` · `track-item-droppable-zone` · `track-row-droppable-zone` · `video-track` · `filmstrip` · `filmstrip-back` · `empty-state` · `empty-state-audio` · `hide-button` |
| Zoom | `toolbar-button-zoom-out` · `-zoom-in` · `-zoom-fit` · `button-collapse-timeline` |
| Right rail | `property-panel-button-captions` (Clipchamp: "Property panel") |

Menu visual (`fui-MenuPopover`): bg **`#1E1E29`** · radius 4px · 1px stroke · shadow16 ·
4px padding · item min-height 32px · icon 20px · text 14px · divider `neutralStroke2`.

Asset tile anatomy: thumb (`video-preview`, opacity .6 jab loading) → progress bar + % →
hover pe `+` (bottom-right, add to timeline) → hover pe `⋮` (top-right, More options) →
title + in-use ✓ checkmark. Right-click bhi menu kholta hai.

Stage Clipchamp me ek real `<canvas>` hai (594×492 backing, 475.2×393.6 CSS) — hum `<video>`
use karte hain, halka hai.

---

## 10. Clipchamp parity (measured from the OBS capture + DOM extract)

Reference: `resource_Clipchamp/clipchamp_OBSrecord.mp4` (Clipchamp **dark mode**, 1280×720 frame)
and `resource_Clipchamp/singleFiles/openclipchamp.html` (SingleFile DOM, menu bg `#1E1E29`).

| Element | Clipchamp | Ours |
| ------- | --------- | ----- |
| Top bar | 40px · launcher · logo · project · cloud | 40px, same order |
| Left rail | 58px, icon + label, rounded pill active | 58px, same (mode switcher) |
| Preview bar | 40px · undo/redo · Size group · Share · Export | 40px, same |
| Canvas | 16:9 centred, ⛶ bottom-right | same |
| **Transport** | **in the timeline row, above the ruler** | same |
| Tool row | left: AI · ✂ · 🧲  · right: zoom | same |
| Ruler | 26px, `mm:ss` | 26px, same |
| Lanes | T 30px → **Video 58px** → **Audio 44px** | same order, same heights |
| Playhead | 2px stem + round handle on the ruler | same |
| Right rail | slim, `CC Captions` | 52px, Transcript + AI |
| Panel resize | `separator` "Resize panel" | same (drag se width) |
| Timeline collapse | `button-collapse-timeline` | same |

**Deliberate deviations from Clipchamp (all ours, none accidental):**
1. Transcript panel on the right of the canvas (resizable, default 340px) — core feature.
2. Nanami gold instead of Clipchamp purple. Gold marks cuts/keeps/accent only.
3. `7:3 Cut / Export` rail instead of Clipchamp's panel switcher — each entry is
   a separate RAM island. (The old `Ingest` page is gone: importing, the project
   shape and the dead-air pass all happen in the Create New Project panel, and
   "My media" lives inside Cut.)
4. Overtime Saved chip in the top bar.
5. Cloud button opens **our** provider menu (Telegram/Gemini/Groq/Local) instead of Microsoft's.

---

## 11. Folder contract (this prototype)

```
Clipchamp_Bunny/
  docs/SPEC.md              <- this file
  src/lib/types.ts          <- TranscriptLine, MenuItem, ProviderState …
  src/lib/mock.ts           <- realistic Hinglish fumble transcript
  src/lib/stores/
    project.svelte.ts       <- lines · cutRanges · undo/redo · skipCuts · splitAt
    player.svelte.ts        <- time / playing / zoom / snap
    mode.svelte.ts          <- epoch counter → drives {#key} teardown
    layout.svelte.ts        <- transcript width · timeline collapsed
    media.svelte.ts         <- media library (metadata only, never bytes)
    cloud.svelte.ts         <- provider states  ⚠ BACKEND SEAM
  src/lib/components/
    TopBar.svelte           <- Clipchamp top bar
    PreviewBar.svelte       <- Clipchamp preview bar
    ModeRail.svelte         <- 58px rail, icon + label
    RightRail.svelte        <- 52px rail, Transcript + AI
    CloudMenu.svelte        <- TG QR / Gemini / Groq / Local  ⚠ BACKEND SEAM
    ContextMenu.svelte      <- Fluent-style popover (#1E1E29)
    MenuIcon.svelte
    media/MediaPanel.svelte <- "My media"
    media/MediaTile.svelte  <- Clipchamp asset tile
    cut/VideoPreview.svelte <- Phantom Cut skip + ⛶ fullscreen
    cut/TranscriptPanel.svelte <- virtual scroll (30 rows in DOM, any length)
    cut/WaveTimeline.svelte    <- tool row · ruler · T/Video/Audio lanes
    modes/{Cut,Export}Mode.svelte
```

---

## 12. Real demo media (no placeholders)

The prototype runs on the **real** video: `resource_Clipchamp/clipchamp_OBSrecord.mp4`
(1920×1080 · H.264 · 60 fps · 197.78 s · AAC 48 kHz · 24.78 MB).

`tools/generate-media.mjs` bakes it with the **exact FFmpeg commands the Rust backend
runs at runtime**, so the prototype data IS the backend data:

| Artifact | Command | Output |
| -------- | ------- | ------ |
| Probe | `ffprobe -show_format -show_streams` | `public/media/media.json` |
| Waveform | `ffmpeg -v error -i SRC -ac 1 -ar 48000 -f s16le -` (streamed, folded into 4096 buckets, normalised to global peak) | `public/media/waveform.json` — shape `{ durationSecs, bars, peaks, cachePath }` = Rust `WaveformData` |
| Filmstrip | `ffmpeg -i SRC -vf "fps=1,scale=160:-2" -q:v 5 -f image2 thumb_%05d.jpg` | `public/media/thumbs/` (198 × 160×90) + `manifest.json` = Rust `ThumbnailStrip` |

In the Tauri build these fetches are replaced by `invoke('probe_cached')`,
`invoke('extract_waveform')` and `invoke('extract_thumbnails')`.

**Zero-RAM at the UI level:** the filmstrip thumbs are fetched **only for the visible
scroll window** (LRU of ~260 images) — a 2-hour timeline never pulls thousands of
JPEGs into the heap.

**Video lane = the export preview.** Kept ranges render as solid filmstrip clips with a
purple border; cut ranges render as **red hatched gaps** behind them. What you see on
the timeline IS what the export will contain.

---

## 13. Drag & drop

App-wide: drag a file anywhere onto the window → a full-screen "Video drop karo" overlay
appears (gold dashed edge, Nanami tie texture) → on drop the file is imported, probed
and becomes the project source, and the app switches to `INGEST`.

Dropped files are filtered to `video/*` and `audio/*`; the first one becomes the
project source, the rest land in the media library.

`Alt + I` opens the same file picker from anywhere in the app.

---

## 14. Keyboard shortcuts

The **complete official Clipchamp list** (Microsoft Support, 2026) is implemented — see
`src/lib/shortcuts.ts` for the registry and `Ctrl + /` in-app for the sheet.

| Clipchamp | Ours | Note |
| --------- | ---- | ---- |
| `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` | same | |
| `S` split | same | splits the line under the playhead |
| `Del` / `Backspace` | same | cuts the selected lines |
| `Ctrl+C` / `Ctrl+V` / `Ctrl+D` | same | copy / paste / duplicate a line |
| `Ctrl+A` / `Esc` | same | select all / deselect all lines |
| `Ctrl+G` / `Ctrl+Shift+G` | same | group / ungroup lines |
| `Space` play-pause | same (+ `K`) | |
| `Ctrl+/` | same | opens the in-app shortcut sheet |
| `Ctrl+←` / `Ctrl+→` | same | seek to start / end |
| `←` / `→` | same | one frame |
| `Shift+←` / `Shift+→` | same | one second |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | same | timeline zoom in / out / fit |
| `Ctrl+Alt+2` / `+3` / `+F` | same | collapse media panel / timeline / both |
| `Alt+1..5`, `Alt+N/I/E/R/H` | same | focus rail / panel / timeline / stage / header, project name, import, export, aspect ratio, help |
| `Z` then `←/→` | same | trim the **start** of the current line |
| `C` then `←/→` | same | trim the **end** of the current line |
| `X` then `←/→` | **`Shift+X` then `←/→`** | ⚠ plain `X` is our **instant cut**; using it as a prefix would add latency to the most-used key |
| `↑` / `↓` | **line navigation** | ⚠ Clipchamp scrolls the timeline here; ours moves the transcript cursor (and the preview with it) — that is the whole workflow |
| — | `X` / `V` | our one-hand flow: cut / keep + auto-advance |
| — | `J` / `L` | seek ∓5 s |

---

## 16. The app runs in two modes

| Mode | How | What is real |
| ---- | --- | ----------- |
| **Desktop (Tauri)** | `npm run app` / `Launch-NanamiCut.bat` | the real Rust engine: ffprobe → SQLite cache, FFmpeg waveform, FFmpeg filmstrip, SQLite transcript, `detect_silence`, export |
| **Browser** | `npm run dev` → http://localhost:5174 | the UI, against the media baked by `tools/generate-media.mjs` |

The Rust **engine is shared with the T9EditorLIT crate** — every module is included
by path (`#[path = "../../../src-tauri/src/….rs"]`), so there is exactly one
implementation of the FFmpeg / SQLite / export / memory code in the repository.
A fix in the engine lands in both apps.

## 17. The edit timeline (drag & drop)

The bottom block is the **final video**, not the source:

| Lane | Height | What it is |
| ---- | ------ | ---------- |
| **Source minimap** | 7px | the whole original, red where it was cut |
| **Ruler** | 24px | edit time (0:00 = start of the final video) |
| **Video** | 52px | **draggable clips**, real filmstrip inside, gold border |
| **Audio** | 44px | the waveform of each kept segment, traffic-light coloured |

Drag a clip → it moves in the final video → **the transcript rows reorder live**
(the panel renders `project.orderedLines`, the final-video order).

The maths lives in `src/lib/segments.ts` — pure, no runes, unit-tested
(`segments.test.ts`, 13 tests). The playhead maps source ⇄ edit
(`editTimeAt` / `sourceAt`), so a time inside a cut has **no** edit position —
which is exactly the Phantom Cut behaviour.

## 18. The honesty meter

Top bar, right of the Overtime chip:

```
RAM ▓▓▓▓░░░ 4/8G │ ▮ 4 MB │ ↓ — MB/s
```

- **RAM** — total / used, from the Rust `get_memory_stats` command. The "app" figure
  sums this process **and all of its descendants** (the WebView2 renderers), so it does
  not under-report.
- **This app** — what Nanami Cut is costing right now, in MB.
- **Network** — a real download burst against a public speed endpoint, in MB/s.
- **Click** → the full PC panel: OS, host, uptime, CPU (brand / cores / load / MHz),
  RAM breakdown, this app's CPU, and every drive with free/total and a usage bar.

`src-tauri/src/sysinfo_ext.rs` provides the snapshot (`system_details` command).

## 19. Auto-cut silence

Clipchamp's AI auto-cut scans for **pauses longer than three seconds**. Ours does the
same through the Rust `detect_silence` command (FFmpeg `silencedetect`, `-30 dB`,
`minSecs = 3.0`), then marks every transcript line that overlaps a silent span as cut.

The ✨ button in the timeline tool row runs it. `project.autoCutSilence()` returns the
number of lines it cut.

## 20. Split rules

| Rule | Value | Why |
| ---- | ----- | ---- |
| Minimum line that can be split | 0.5 s | below that a split has no meaning |
| Minimum sliver left on either side | 0.25 s | |
| Auto-cut silence threshold | 3.0 s | Clipchamp's documented rule |
| Silence threshold | −30 dB RMS | FFmpeg default in our Rust wrapper |

`S` splits the line under the playhead; if the playhead is on a line boundary
(which happens when you *click* a transcript row, because the playhead jumps to
the row's start) the **cursor line** is used instead and the cut point is clamped
inside it. So `S` always does something sensible.

## 21. The app's purpose (locked)

**T9 Editor LIT** does two things, and only two:

1. **Hatana** — the dead air (silences) out of a long recording.
2. **Edit by reading** — cut the fumbles / retakes / wrong examples by reading
   the transcript, not by scrubbing a timeline.

| Mode | Job |
| ---- | --- |
| **MEDIA** | import · probe · **DEAD AIR** workbench (threshold slider, silence list, cut-all) |
| **CUT** | read the transcript · ✕ / ✓ per line · drag clips to reorder · live transcript update |

**Export** is not a mode — it is the purple button on the preview bar, exactly
where Clipchamp puts it. The left rail therefore has **two** entries.

## 22. Import sources

| Source | How |
| ------ | --- |
| **File manager** | "Import media" (multi-select) or the caret menu. Several files at once. |
| **Link** | caret → "From a link" → `yt-dlp` downloads it (1080p cap, mp4 merge) straight to disk — the bytes never touch the app's heap |
| **Telegram vault** | caret → "From Telegram vault" → the QR / MTProto handshake |
| **Drag & drop** | anywhere in the window |

**A file that arrives while a project is open starts a new project.** The old
one stays in the library and can be reopened.

## 23. The network speed meter — why it lied before

The first implementation timed the whole `fetch`, so DNS + TCP + TLS + TTFB got
divided into the transfer time. A 40 Mbps line read as 2 MB/s.

Now the clock starts when the **first body byte** arrives, the transfer runs for
a fixed 3-second window, and the result is reported in **Mbps** (the unit a
browser shows) *and* MB/s.

## 24. Launching

```bat
.\Launch-T9EditorLIT.bat          :: release exe, ya pehli baar banata hai
.\Launch-T9EditorLIT.ps1 -Dev     :: cargo dev + hot reload
```

The first launch compiles ~380 Rust crates and takes **10–15 minutes**; the
launcher says so and then never does it again. `npm run app` always recompiles —
which is why the launcher prefers the release build.

## 25. Backend seams (backend agent yahan plug karega)

| UI jagah | Kya plug hoga |
| -------- | ------------- |
| `cloud.svelte.ts` → `connect(id)` | `telegram` → Go `POST /v1/vault/authorise` (QR) + `/v1/vault/upload`; `gemini` → `/v1/analyze`; `groq` → `/v1/transcribe` |
| `CloudMenu.svelte` → QR modal | real QR image from `GET /v1/vault/authorise/{id}` |
| `media.svelte.ts` → `addPath` | Rust `probe` + `extract_thumbnails` (file:// / asset:// URL) |
| `project.svelte.ts` → `loadFromBackend` | Rust `extract_waveform` + `extract_thumbnails` + SQLite `load_transcript` |
| `MediaPanel` → "From a link" | Rust `download_from_url` (yt-dlp) — already wired |
| `WaveTimeline` video lane | Rust `extract_thumbnails` → real filmstrip |
| `ExportMode` | Rust `start_export` (hybrid / copy / encode) — already wired |

---

## 26. Status

- [x] SPEC freeze
- [x] Prototype scaffold (Vite + Svelte 5 + Tailwind 4)
- [x] Tauri shell sharing the Rust engine by `#[path]` include
- [x] Real backend wiring: probe · waveform · filmstrip · SQLite transcript · silence · export
- [x] MEDIA mode: import (multi / link / Telegram / drop) + DEAD AIR workbench
- [x] CUT mode: preview + transcript ✓/✕ + editable timeline + drag to reorder
- [x] Edit timeline: source minimap · ruler · T · draggable clips · audio
- [x] Honesty meter: RAM · app MB · real network speed · full PC + storage popover
- [x] Full Clipchamp shortcut set + in-app sheet (`Ctrl+/`)
- [x] App renamed to **T9 Editor LIT**; `Launch-T9EditorLIT.bat` / `.ps1`
- [ ] Real Whisper/Gemini transcript (t9cloud `/v1/transcribe`) — scaled mock abhi
- [ ] Telegram vault file download into the media library
- [x] Text / zoom overlays - removed for now; the timeline has no text lane