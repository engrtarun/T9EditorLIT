# Architecture

Reference for how T9EditorLIT is put together and why each piece is there.
Read this before adding a feature.

---

## 1. The one rule everything serves

**Nothing large is ever resident in RAM.**

Every design decision below is downstream of that. On the target machine
(Windows 11, i3, 8 GB, already ~80 % occupied by the OS and other apps) a
conventional NLE loads the timeline, transcript, colour engine, audio mixer,
effects library and font cache simultaneously. That is the entire reason
Premiere, DaVinci and CapCut are unusable there. T9EditorLIT refuses to do it.

Three mechanisms enforce the rule:

| Mechanism                         | Where                                           | Effect                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mode-Based Panel Isolation**    | `src/lib/stores/mode.svelte.ts`, `+page.svelte` | Only one mode's component tree exists. Switching modes destroys the previous one via `{#key}`.                                                            |
| **Process isolation + hard kill** | Rust, FFmpeg child processes                    | Heavy work (transcode, chunking, export) runs in a child process that is killed outright when done. Windows reclaims the memory immediately — no GC wait. |
| **Disk-backed state**             | SQLite (Chunk 2)                                | Transcript lines and decisions live in a file, not in a heap.                                                                                             |

The RAM meter in the top bar exists to make violations visible. If the app's
footprint grows while you idle, something has been loaded that should not be.

---

## 2. Repository layout

```
T9EditorLIT/
├── .github/workflows/ci.yml     # type-check, lint, clippy, test, Windows build
├── .env.example                 # every secret the app will ever need
│
├── src/                         # ── Frontend: TypeScript + Svelte 5 + Tailwind 4
│   ├── app.css                  # Nanami Kento design tokens
│   ├── app.html
│   ├── routes/
│   │   ├── +layout.svelte       # global styles
│   │   └── +page.svelte         # app shell — owns the {#key} mode swap
│   └── lib/
│       ├── types.ts             # mirrors of the Rust structs (camelCase)
│       ├── ipc.ts               # the only place `invoke` is called
│       ├── stores/
│       │   ├── mode.svelte.ts   # Mode-Based Panel Isolation
│       │   ├── memory.svelte.ts # RAM meter polling state
│       │   └── project.svelte.ts# loaded source + ffprobe facts
│       └── components/
│           ├── TopBar.svelte    # identity · mode switch · RAM meter
│           ├── ModeSwitcher.svelte
│           ├── RamMeter.svelte
│           ├── SourceBar.svelte # file picker + environment check
│           └── modes/
│               ├── CutMode.svelte     # preview │ transcript │ timeline
│               └── PolishMode.svelte  # music & text (Chunk 5)
│
└── src-tauri/                   # ── Backend: Rust
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/default.json
    └── src/
        ├── main.rs
        ├── lib.rs               # #[tauri::command] surface
        ├── ffmpeg.rs            # child-process wrappers, encoder detection
        ├── media.rs             # ffprobe → MediaInfo  (has unit tests)
        └── memory.rs            # sysinfo probe, app-tree RAM  (has unit tests)
```

`.env`, `media/`, `workspace-data/`, `*.db` and all media files are git-ignored.
Nothing that reaches disk is ever committed by accident.

---

## 3. Layer boundaries

```
┌──────────────────────────────────────────────┐
│ Svelte components                            │  never call invoke directly
├──────────────────────────────────────────────┤
│ lib/ipc.ts        (typed wrappers only)      │  single choke point
├──────────────────────────────────────────────┤
│ #[tauri::command]  in src-tauri/src/lib.rs   │
├──────────────────────────────────────────────┤
│ media.rs · ffmpeg.rs · memory.rs             │  pure logic, unit-tested
├──────────────────────────────────────────────┤
│ OS: ffprobe / ffmpeg child processes          │  all media work happens here
└──────────────────────────────────────────────┘
```

Rules:

1. Components never import `invoke` from `@tauri-apps/api/core`. They call a
   named function in `ipc.ts`.
2. `lib.rs` holds no logic — only command signatures. Logic goes in a module so
   it can be unit-tested without Tauri.
3. Serde uses `rename_all = "camelCase"` on every struct crossing the boundary;
   `types.ts` mirrors it exactly. A mismatch fails silently at runtime, so keep
   them in lockstep.

---

## 4. Chunk plan

### Chunk 1 — Skeleton, theme, mode switcher, RAM meter, CI ✅ _(current)_

Working app window, Nanami Kento theme, mode isolation wired, RAM meter live,
ffprobe inspection working, CI building a Windows `.exe` on GitHub.

### Chunk 2 — Zero-RAM audio → cloud transcript → SQLite

1. `ffprobe` the source (already done — `MediaInfo`).
2. FFmpeg extracts mono 16 kHz audio and splits it into ~15 MB chunks. Groq's
   free tier rejects anything over 25 MB, and a 2-hour extract exceeds that.
3. Chunks go to **Groq Whisper Large v3**. Each returns segment-level
   timestamps; Rust offsets them by the chunk's start time to build one
   continuous timeline.
4. The transcript goes to **Gemini 2.5 Flash** with the creator's tone profile
   (`@EngrTarunDilwal`). It marks silence, fumbles, repeated lines and
   self-corrected wrong examples — defaulting those to `keep: false`.
5. Everything lands in SQLite. Nothing stays in the heap.

### Chunk 3 — The Cut Panel

- Virtual scroll: only the ~30 lines in the viewport are in the DOM.
- Clicking `✕` performs a **phantom cut** — a SQLite write plus a skip
  instruction for the player. The 5 GB file is not touched until export.
- Waveform from FFmpeg-extracted peak data on a small canvas.
- Thumbnail strip sampled at ~1 fps, cached to disk on load.
- Keyboard: `Space`/`K` play, `J`/`L` scrub, `X` cut, `V` keep, `Ctrl+Z` undo.

### Chunk 4 — Smart hybrid export

- Segments that fall on a keyframe boundary are copied with `-c copy`.
- Segments mid-GOP get a short QuickSync (`h264_qsv`) encode — exact cuts without
  dragging the whole 2-hour file through a CPU re-encode.
- Result: original 1080p/4K quality, minutes instead of hours, tens of MB of RAM.

### Chunk 5 — Polish mode and Telegram vault

- Music deck with speech ducking; text and heading overlays.
- MTProto backup via Rust `grammers`, split into ≤2 GB parts — unlike the Bot
  API's 50 MB ceiling.

---

## 5. Environment variables

All secrets live in `.env` (git-ignored). Copy from `.env.example`.

| Variable                                                                            | Used by                          | Chunk |
| ----------------------------------------------------------------------------------- | -------------------------------- | ----- |
| `GROQ_API_KEY`                                                                      | Whisper transcription            | 2     |
| `GROQ_TRANSCRIBE_MODEL`                                                             | Model selection                  | 2     |
| `GROQ_MAX_CHUNK_MB`                                                                 | Audio chunk sizing               | 2     |
| `GEMINI_API_KEY`                                                                    | Retake / wrong-example detection | 2     |
| `GEMINI_MODEL`                                                                      | Model selection                  | 2     |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_PHONE` / `TELEGRAM_TARGET_CHAT` | MTProto vault                    | 5     |

None of these are needed to run the Chunk 1 app.

---

## 6. Rules of thumb

- **Adding a panel?** Decide which mode owns it. Two modes must never be
  resident at once.
- **Touching media?** Go through a child process. Do not buffer frames.
- **Crossing the IPC boundary?** Update both `types.ts` and the Rust struct.
- **Something feels slow on the i3?** Check the RAM meter first. It is almost
  always a resident-state problem, not a CPU problem.
