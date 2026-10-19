# Nanami Cut

> Zero-RAM, transcript-first video cutter for long Hinglish coding tutorials.
> **"No Overtime"** — Nanami Kento theme.

Full requirement freeze: [`docs/SPEC.md`](docs/SPEC.md)

---

## Chalane ka do tareeka

### 1. Desktop app ( asli Rust engine)

```bash
# repo root se
.\Launch-NanamiCut.bat
# ya
.\Launch-NanamiCut.ps1          # dev build, hot reload
.\Launch-NanamiCut.ps1 -Release # optimised build
```

Ya direct:

```bash
cd Clipchamp_Bunny
npm install
npm run app          # tauri dev
npm run app:build    # release build → src-tauri/target/release/nanami-cut.exe
```

### 2. Browser (UI only, baked media)

```bash
cd Clipchamp_Bunny
npm run dev          # http://localhost:5174
```

Desktop app me **real** hota hai: ffprobe → SQLite cache, FFmpeg waveform,
FFmpeg filmstrip, SQLite transcript, `detect_silence`, export.
Browser me baked media se (same FFmpeg commands, offline).

Checks:

```bash
npm run check        # svelte-check — 0 errors
npm run lint         # prettier
npm test             # node --test
```

---

## Kya banaya hai

| | |
|---|---|
| **4 zero-RAM modes** | `INGEST` · `7:3 CUT` · `POLISH` · `EXPORT` — `{#key}` se switch hote hi pichla mode destroy |
| **7:3 Cut dashboard** | video preview · transcript ✓/✕ (virtual scroll) · editable timeline |
| **Phantom Cut** | cut ranges preview me skip ho jaate hain — video kabhi re-encode nahi hota |
| **Traffic-light waveform** | gold = keep · red = fumble/galat · grey = khamoshi |
| **Edit timeline** | source minimap · ruler · T · draggable video clips · audio — drag karo, transcript live reorder hota hai |
| **Honesty meter** | RAM used/total · this app's MB · real network speed · click → full PC + storage panel |
| **Full Clipchamp shortcut set** | `Ctrl+/` opens the in-app sheet |
| **Drag & drop** | video drop karo kahin bhi → import + probe + project source |
| **Auto-cut silence** | ✨ button → FFmpeg `silencedetect`, 3 s+ pauses auto-cut |
| **Provider menu** | Telegram Cloud (QR + MTProto) · Gemini · Groq · Local disk |
| **Shared Rust engine** | `#[path]` include — T9EditorLIT ka engine, ek copy nahi |

## Keyboard

| Key | Action |
| --- | ------ |
| `Space` / `K` | play / pause |
| `X` | cut the current line → auto-advance |
| `V` | keep the current line → auto-advance |
| `S` | split the line under the playhead |
| `Del` / `Backspace` | cut the selected line(s) |
| `Ctrl+C` `Ctrl+V` `Ctrl+D` | copy / paste / duplicate a line |
| `Ctrl+A` / `Esc` | select all / deselect |
| `Ctrl+G` / `Ctrl+Shift+G` | group / ungroup |
| `Z` then `←/→` / `C` then `←/→` | trim start / end of the line |
| `Shift+X` then `←/→` | move the line |
| `↑` / `↓` | previous / next line (preview jumps too) |
| `J` / `L` | seek ∓5 s |
| `Ctrl+=` `Ctrl+-` `Ctrl+0` | timeline zoom |
| `Ctrl+Alt+2` `+3` `+F` | collapse media panel / timeline / both |
| `Alt+1..5`, `Alt+N/I/E/R/H` | focus rail / panel / timeline / stage / header, project, import, export, aspect, help |
| `Ctrl+/` | shortcut sheet |

## Structure

```
Clipchamp_Bunny/
  docs/SPEC.md                 ← the frozen requirement
  docs/compare-vs-clipchamp.png
  src/lib/segments.ts          ← pure edit-timeline maths (unit-tested)
  src/lib/ipc.ts               ← the ONLY place that talks to Rust
  src/lib/stores/*.svelte.ts   ← project · player · mode · layout · media · cloud · toast
  src/lib/components/          ← TopBar · PreviewBar · ModeRail · RightRail · CloudMenu
                                  SystemMeter · ContextMenu · ShortcutsHelp · Toasts
                                  cut/ · media/ · modes/
  src-tauri/src/lib.rs         ← shares the engine by #[path] include
  src-tauri/src/sysinfo_ext.rs ← the PC-details probe
  tools/generate-media.mjs     ← bakes the demo media with the real FFmpeg commands
```

## Bans

Python · Electron · Qt/C++ · React · Tailwind v3 — inme se koi nahi.
Media kabhi RAM me buffer nahi hota: FFmpeg child processes, SQLite on disk,
filmstrip thumbnails sirf visible window ke liye fetch hote hain.
