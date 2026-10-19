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

## 3. Four-mode pipeline (the core idea)

Ek waqt me **sirf ek mode RAM me zinda** hota hai. Baaki 3 ka component tree `{#key}` se
destroy/unmount hota hai. Mode switch = **hard memory drop** (JS GC + Rust `drop()`).

| # | Mode          | Kaam | RAM me kya hai |
| - | ------------- | ---- | -------------- |
| 1 | **INGEST**    | Video drop → FFmpeg audio → cloud transcript + AI fumble marks | sirf drop zone + progress |
| 2 | **7:3 CUT**   | Main dashboard: preview + transcript ✓/✕ + wave/clip timeline | yehi poora panel |
| 3 | **POLISH**    | Text / zoom / music (Apna College style) | transcript **destroyed** |
| 4 | **EXPORT**    | Lossless export + Telegram vault upload | preview + waves **destroyed** |

Mode 2 me 90% kaam hota hai → isliye default landing mode.

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
- Bottom → audio waves + FPS thumbnail timeline + text lane.

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

## 8. Theme — Nanami Kento "No Overtime"

| Token | Value | Use |
| ----- | ----- | --- |
| `--nc-bg` | `#12131A` | app background (deep charcoal, raat-friendly) |
| `--nc-panel` | `#171821` | panels |
| `--nc-panel-2` | `#1E202B` | raised / hover |
| `--nc-line` | `#2A2C38` | borders |
| `--nc-gold` | `#D4AF37` | primary accent (buttons, active rail, keep) |
| `--nc-gold-dim` | `#8A7328` | inactive gold |
| `--nc-red` | `#E5484D` | cut / fumble |
| `--nc-green` | `#3DD68C` | keep |
| `--nc-txt` | `#ECECF2` | text |
| `--nc-mut` | `#9A9AA8` | muted |

Nanami ka rule: **no overtime, no wasted work, 7:3 ratio one strike.**

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
3. `Ingest / 7:3 Cut / Polish / Export` rail instead of Clipchamp's panel switcher —
   each entry is a separate RAM island.
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
    modes/{Ingest,Cut,Polish,Export}Mode.svelte
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

## 15. Backend seams (backend agent yahan plug karega)

| UI jagah | Kya plug hoga |
| -------- | ------------- |
| `cloud.svelte.ts` → `connect(id)` | `telegram` → Go `POST /v1/vault/authorise` (QR) + `/v1/vault/upload`; `gemini` → `/v1/analyze`; `groq` → `/v1/transcribe` |
| `CloudMenu.svelte` → QR modal | real QR image from `GET /v1/vault/authorise/{id}` |
| `media.svelte.ts` → `add()` | Rust `probe` + `extract_thumbnails` (file:// / asset:// URL) |
| `project.svelte.ts` → `loadFile` | Rust `extract_audio_chunks` + SQLite `save_transcript` |
| `WaveTimeline` video lane | Rust `extract_thumbnails` → real filmstrip (abhi gradient mock) |
| `ExportMode` | Rust `start_export` (smart copy / QSV / CPU) |

---

## 13. Status

- [x] SPEC freeze
- [x] Prototype scaffold (Vite + Svelte 5 + Tailwind 4)
- [x] Mode 1 INGEST (My media panel + pipeline)
- [x] Mode 2 7:3 CUT (preview + transcript + T/Video/Audio timeline)
- [x] Mode 3 POLISH
- [x] Mode 4 EXPORT + vault mock
- [x] Keyboard flow + auto-advance
- [x] **Step 1 — Clipchamp parity**: transport neeche, lane order, ✂ split, 🧲 snap,
      rail labels, right rail, top bar restructure
- [x] **Step 2 — Clipchamp components**: cloud/provider menu (TG QR · Gemini · Groq),
      "My media" panel + asset tile, Fluent context menu, resize separator,
      collapse timeline, gradient picker
- [ ] Real FPS thumbnails in the video lane (Rust `extract_thumbnails` already exists)
- [ ] Tauri shell + Rust FFmpeg wiring