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

## 9. Folder contract (this prototype)

```
Clipchamp_Bunny/
  docs/SPEC.md              <- this file
  src/lib/types.ts          <- TranscriptLine, Mode, ProjectState
  src/lib/mock.ts           <- realistic Hinglish fumble transcript
  src/lib/stores/*.svelte.ts<- project / player / transcript / mode
  src/lib/components/
    TopBar.svelte
    ModeRail.svelte
    modes/IngestMode.svelte
    modes/CutMode.svelte    <- MAIN
    modes/PolishMode.svelte
    modes/ExportMode.svelte
    cut/VideoPreview.svelte
    cut/TranscriptPanel.svelte   <- virtual scroll + ✓/✕
    cut/WaveTimeline.svelte      <- ruler + wave + fps strip + text lane
    cut/OvertimeCounter.svelte
```

Backend (Rust/FFmpeg/SQLite) is prototype ke baad wire hoga — `lib/ipc.ts` ke through.

---

## 10. Status

- [x] SPEC freeze
- [x] Prototype scaffold (Vite + Svelte 5 + Tailwind 4)
- [ ] Mode 1 INGEST (drop zone + mock progress)
- [ ] Mode 2 7:3 CUT (preview + transcript + wave timeline)
- [ ] Mode 3 POLISH
- [ ] Mode 4 EXPORT + vault mock
- [ ] Keyboard flow + auto-advance
- [ ] Tauri shell + Rust FFmpeg wiring