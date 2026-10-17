# T9EditorLIT

**Zero-RAM, transcript-first video cutter for long-form Hindi/Hinglish tech tutorials.**

Built for one specific machine and one specific creator: **Windows 11 · i3 · 8 GB RAM (already
~80 % occupied)** cutting **1080p/4K @ 50–60 FPS, up to 5 GB / 2 hours** of screen-recorded
tutorials — in the style of _Apna College_ and _Coder Army_.

Everything here is designed around three non-negotiable constraints:

| Constraint                      | Design response                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **8 GB RAM, 80 % already used** | Mode-based isolation. Only the active mode is resident. Heavy work runs in killable child processes. |
| **5 GB / 2-hour 4K60 source**   | Zero full-file loads. Streamed from disk, cut by timestamp, never re-rendered.                       |
| **Weak i3 CPU**                 | FFmpeg _stream copy_ + Intel QuickSync. Heavy AI runs in the cloud, not on your PC.                  |

---

## The core idea

Normal editors (CapCut, Premiere, DaVinci) keep the **timeline, transcript, colour engine, audio
mixer, effects library and font cache** all loaded at once. That is exactly what kills an 8 GB
machine.

T9EditorLIT does the opposite — **Mode-Based Panel Isolation**:

```
┌─ Mode 1: TRANSCRIPT & CUT ────────────────────────────┐
│  Resident: video streamer · waveform · ✓/✕ panel     │
│  Evicted : music engine · text engine · B-roll (0 RAM)│
└───────────────────────────────────────────────────────┘
                        ↓ switch
┌─ Mode 2: MUSIC & TEXT ───────────────────────────────┐
│  Resident: music deck · text/pipeline panel          │
│  Evicted : transcript DOM · waveform (flushed to disk)│
└───────────────────────────────────────────────────────┘
```

Plus a live **RAM meter** in the top bar, so the truth is always visible instead of guessed at.

---

## Tech stack (locked)

| Layer        | Technology                                                          |
| ------------ | ------------------------------------------------------------------- |
| App shell    | **Tauri v2** — reuses Windows' built-in WebView2, no bundled Chrome |
| Frontend     | **TypeScript + Svelte 5 + Tailwind CSS 4**                          |
| Core backend | **Rust** — native speed, real memory release to the OS              |
| Media engine | **FFmpeg + FFprobe** (QuickSync + stream copy)                      |
| Storage      | **SQLite** (via Rust) — disk, not RAM                               |
| Cloud AI     | **Groq (Whisper Large v3)** + **Gemini 2.5 Flash**                  |
| Cloud vault  | **Telegram MTProto** via Rust                                       |
| CI/CD        | **GitHub Actions** — the build happens on GitHub, never on your i3  |

No Python anywhere in the pipeline, and no Go server.

---

## The cut panel

```
┌──────────────────────────────┬─────────────────────────────┐
│                              │  TRANSCRIPT          ▐▌     │
│      VIDEO PREVIEW           │  ─────────────────────────── │
│                              │  00:12 – 00:14  ✕  line...  │
│  streamed from disk, never   │  00:15 – 00:20  ✓  line...  │
│  fully in RAM; auto-skips ✕  │  00:21 – 00:26  ✓  line...  │
│                              │  00:27 – 00:31  ✕  wrong ex.│
├──────────────────────────────┴─────────────────────────────┤
│  ── audio waveform (speech vs silence clearly visible) ──  │
├────────────────────────────────────────────────────────────┤
│  ▣▣▣▣▣ video thumbnail / FPS strip ▣▣▣▣▣                 │
└────────────────────────────────────────────────────────────┘
```

Every line carries a timestamp range and a verdict:

- **✓ Keep** — stays in the final video
- **✕ Cut** — skipped in preview, dropped at export

### Phantom cut

Clicking **✕** never touches the 5 GB file. It writes a decision and tells the player to skip that
range. The cut feels instant; the real work happens once, at export.

### Shortcuts

| Key                  | Action                                |
| -------------------- | ------------------------------------- |
| `Space` / `K`        | Play / pause                          |
| `J` / `L`            | Jump back / forward                   |
| `X`                  | Toggle **✕ Cut** on the focused line  |
| `V`                  | Toggle **✓ Keep** on the focused line |
| `S` / `C` / `Ctrl+B` | Split at playhead                     |
| `Ctrl+Z`             | Undo                                  |
| `Ctrl+1` / `Ctrl+2`  | Jump to Cut / Polish mode             |

---

## Build status

| Chunk | Scope                                                                                   | State      |
| ----- | --------------------------------------------------------------------------------------- | ---------- |
| **1** | Project skeleton · Nanami Kento UI shell · mode isolation · RAM meter · ffprobe · CI/CD | ✅ Done    |
| **2** | Zero-RAM audio chunker → Groq transcript → Gemini "Tarun Tone" brain → SQLite           | ⬜ Planned |
| **3** | Cut Panel dashboard · virtual scroll · phantom cut · waveform · thumbnails              | ⬜ Planned |
| **4** | Smart hybrid export engine (stream copy + QuickSync fallback)                           | ⬜ Planned |
| **5** | Polish mode (music/text) · Telegram MTProto vault                                       | ⬜ Planned |

---

## Prerequisites

All already present on the target machine.

| Tool     | Version used                           |
| -------- | -------------------------------------- |
| Rust     | 1.99+                                  |
| Node.js  | 24.x                                   |
| npm      | 11.x                                   |
| FFmpeg   | 9.0 — **must be on `PATH`**            |
| WebView2 | Evergreen (preinstalled on Windows 11) |

---

## Development

```bash
npm install          # frontend dependencies

npm run dev          # Vite dev server only (UI, no Rust)
npm run tauri dev    # full desktop app

npm run check        # svelte-check + TypeScript
npm run lint         # prettier --check
npm run format       # prettier --write

npm run tauri build  # production build -> src-tauri/target/release/bundle
```

### Build on GitHub instead of your PC

Pushing to `main` runs, on GitHub's free runners:

1. `prettier --check`
2. `svelte-check`
3. `cargo fmt --check`
4. `cargo clippy --all-targets -- -D warnings`
5. `cargo test`
6. Windows `.exe` build → downloadable artifact

Your i3 never compiles the Rust tree.

---

## Configuration

```bash
cp .env.example .env
```

`.env` is git-ignored. Nothing is required to run the Chunk 1 app; transcription
(Groq/Gemini) and the Telegram vault only need keys at Chunks 2 and 5.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — folder layout, layer boundaries, chunk plan,
  and the rules that keep RAM flat

---

## Licence

MIT — see [LICENSE](LICENSE).
