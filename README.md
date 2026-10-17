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
| Cloud daemon | **Go** (`go/`) — owns stateful / long-running cloud work            |
| Cloud vault  | **Telegram MTProto**                                                |
| CI/CD        | **GitHub Actions** — the build happens on GitHub, never on your i3  |

No Python anywhere in the pipeline. Go is scoped deliberately narrowly — see below.

---

## The Go daemon (`go/`)

The desktop app is local by design. `t9cloud` is the part that is not, and it owns
exactly the work that should not die when you close a window:

| Work                                         | Owner  | Why                                            |
| -------------------------------------------- | ------ | ---------------------------------------------- |
| ffprobe / ffmpeg / cutting / export          | Rust   | CPU- and disk-bound, needs a hard process kill |
| Splitting audio into ≤15 MB chunks           | Rust   | Streams through FFmpeg, never buffers          |
| Transcript + ✓/✕ decisions                   | Rust   | SQLite on disk; must survive restarts          |
| Uploading each chunk to Groq                 | **Go** | Long-running, retryable, bounded queue         |
| Flagging retakes / wrong examples via Gemini | **Go** | Long-running, retryable                        |
| Holding the Telegram MTProto session         | **Go** | **MTProto sessions are stateful**              |

That last row is the whole justification for a third language. A Telegram MTProto
session is tied to a long-lived authorised connection — close the desktop app and
the user is staring at an OTP prompt. A daemon keeps it alive on disk.

Everything else stayed in Rust on purpose. Groq and Gemini are plain HTTPS calls;
routing them through another process would add a network hop and three new failure
modes for zero benefit.

**The 5 GB file never crosses the process boundary.** The app hands over _paths to
already-split audio chunks_, not bytes. The daemon streams each chunk to the
provider through an `io.Pipe`.

Other properties worth knowing:

- **Backpressure, not buffering.** The queue is bounded; a full queue answers
  `429` so the client slows down instead of the daemon swallowing the machine.
- **Retry only what can succeed.** 429/5xx are retried with exponential backoff;
  400/401 never, because a bad API key fails identically forever.
- **Loopback only.** The daemon holds your API keys and has no authentication, so
  it refuses to bind anything but `127.0.0.1` — checked twice, once in config and
  once in `main`.
- **Zero third-party dependencies.** Standard library only, so `go build` works
  offline and CI needs no module cache.
- **Partial beats failed.** One bad chunk out of forty does not discard the
  transcript; the job returns `partial` with the failing chunk named.

Full API reference: [`go/README.md`](go/README.md).

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

The Go daemon:

```bash
cd go
make run             # t9cloud, reads ./.env
make check           # gofmt + vet + test + race — exactly what CI runs
make build           # -> go/bin/t9cloud.exe
```

### Build on GitHub instead of your PC

Pushing to `main` runs, on GitHub's free runners:

| Job        | Checks                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `check`    | `prettier --check`, `svelte-check`, `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` |
| `go`       | `gofmt -l`, `go vet`, `go test -race` (independent — seconds, no Rust toolchain wait)             |
| `go-build` | `t9cloud` binaries for linux/amd64, linux/arm64, windows/amd64                                    |
| `build`    | Windows `.exe` installer → downloadable artifact (needs `check` **and** `go`)                     |

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
