# Agent Worklog / Coordination

This file is the shared handoff board for parallel agents. Update it before and after
touching a lane so two agents never edit the same files.

## ⚠️ Mandatory Agent Git Rule

1. **Commit locally upon finishing:** When your work passes `npm run verify:fast`, make a local git commit with your agent name:
   `git commit -m "feat(<scope>): <description>" --author="Agent <YourName> <agent@local>"`
2. **DO NOT PUSH:** Agents must **NEVER** run `git push`. Pushing to remote is reserved exclusively for the human user.

## Agent 5 (this session) — "Home dashboard (landing screen)"

**Lane:** The app's landing screen — `T9 Editor LIT Dashboard.png` ke hisaab se.
Taskbar icon / desktop shortcut / launcher se app ab **dashboard** par khulta hai;
editor (media · cut · export) uske andar hai, koi feature hata nahi.

**Status:** Complete. `svelte-check` 0 errors · `prettier --check` clean ·
`node --test` 13/13 · `cargo test --lib` 62/62 · `cargo check` clean.

**Files owned (editing):**

- `Clipchamp_Bunny/src/lib/components/dashboard/{HomeDashboard,DashboardTopBar,ProjectCard,BrandMark}.svelte` (new)
- `Clipchamp_Bunny/src/lib/dashboard.ts` (new — pure helpers: sort · "3 hours ago" · sizes)
- `Clipchamp_Bunny/src/lib/stores/app.svelte.ts` (new — `home` <-> `editor`)
- `Clipchamp_Bunny/src/App.svelte`, `src/main.ts`, `src/app.css` (motion + screen switch)
- `Clipchamp_Bunny/src/lib/ipc.ts` (new wrappers only — no existing one changed)
- `Clipchamp_Bunny/src/lib/components/TopBar.svelte` (9-dot button -> Home)
- `Clipchamp_Bunny/src-tauri/src/lib.rs` (new commands only), `src-tauri/src/sysinfo_ext.rs`
- `src-tauri/src/transcript.rs` (**additive only** — `trash` table + 4 functions; nothing existing touched)
- `Clipchamp_Bunny/docs/MEMORY.md`

**Do NOT touch (other agents may own):**

- `go/**` — the daemon is the other agent's lane (deploy.ps1 rebuilds it automatically)
- `Clipchamp_Bunny/src/lib/components/modes/**`, `cut/**`, `media/**` — the editor itself
- `Clipchamp_Bunny/src/lib/stores/{project,player,media,cloud,keys,layout,toast,menu}.svelte.ts`

**Contracts exposed for other agents:**

- Rust: `extract_poster(path, at_secs?, width?) -> Poster { path, width, height, cached }`
  (one frame, disk-cached at `<app_data>/cache/posters/<key>.jpg`),
  `drive_space() -> Option<DriveSpace { drive, totalBytes, freeBytes }>`,
  `trash_project` / `restore_project` / `load_trash` / `purge_trash` (db_path, source_path)
- TS: `extractPoster`, `driveSpace`, `trashProject`, `restoreProject`, `loadTrash`, `purgeTrash`,
  `updateProjectOpened`, `revealPath`; store `app` (`view`, `section`)
- SQLite: new table `trash(id, name, source_path, duration_secs, deleted_at)` —
  **the video file is never deleted**, only the app's row moves

**Behaviour change other agents must know about:**

- `main.ts` **no longer calls `project.init()`** at startup. The dashboard shows
  the project list from one SQLite query; the project is loaded when the user
  opens it. If you add a startup path that needs a project, call
  `project.init()` **explicitly** — it is no longer automatic.

---

## Agent 6 (this session) — "Status bar: live system meters"

**Lane:** The dashboard's footer (`SystemFooter.svelte`). RAM, disk, network and
the clock — every number real, one Rust call per second.

**Status:** Complete. `svelte-check` 0 errors · `prettier --check` clean ·
`node --test` 13/13 · `cargo test --lib` 67/67 · `cargo check` clean.

**Files owned (editing):**

- `Clipchamp_Bunny/src-tauri/src/meters.rs` (new — network probe, app-storage
  probe, `system_snapshot`, `set_system_clock`)
- `Clipchamp_Bunny/src-tauri/src/lib.rs` (module + two commands; additive only)
- `Clipchamp_Bunny/src/lib/stores/meters.svelte.ts` (new — the 1 s heartbeat)
- `Clipchamp_Bunny/src/lib/components/SystemFooter.svelte` (new — the bar)
- `Clipchamp_Bunny/src/lib/components/WorldClock.svelte` (new — the popup)
- `Clipchamp_Bunny/src/lib/{ipc.ts,types.ts}` (new wrappers + mirrors)
- `Clipchamp_Bunny/src/lib/components/dashboard/HomeDashboard.svelte` (footer only)

**Do NOT touch (other agents may own):**

- `go/**` — the Go daemon is the other agent's lane. The network meter reads
  the **OS interface counters** from Rust, so the daemon needs no change.
- `Clipchamp_Bunny/src/lib/components/TopBar.svelte`, `SystemMeter.svelte` —
  the editor's own meter is untouched for now.
- `src-tauri/src/memory.rs`, `src-tauri/src/transcript.rs` — shared engine, read-only here.

**Contracts exposed:**

- Rust: `system_snapshot() -> SystemSnapshot { ram: { appMb, totalMb, usedMb, usedPercent },
  drive: { mount, totalBytes, freeBytes }, appStorageBytes, net: { downBps, upBps, interface } }`,
  `set_system_clock(timeZone?, utcIso) -> String` (admin-only on Windows; the
  real error comes back)
- TS: `systemSnapshot()`, `setSystemClock(tz, iso)`, store `meters`
  (`snapshot`, `error`, `start()` / `stop()` — reference counted)

**Design decisions worth knowing:**

- Network speed comes from the **OS counters** (`sysinfo::Networks`), not a
  speed test: a probe measures the probe, costs traffic, and needs the daemon.
- The busiest adapter is reported, not the sum of all adapters — summing
  double counts a VPN tunnel and the physical link.
- The app's own disk size is cached for 20 s and walked by a streaming
  directory traversal (no buffers, no RAM growth).
- Polling only runs while a screen shows the bar, so an idle app costs nothing.

**One thing for the next agent (do not do this while you are mid-edit):**

`components/TopBar.svelte` still carries the self-update logic inline. It now
lives in **`components/UpdateButton.svelte`** and the dashboard already uses
it. Swapping the editor's inline block for `<UpdateButton />` is a one-line
import + one-line tag — it was left alone here because that file was being
edited at the time.

---

## ⚠ Build ek saath mat karo (dono agents ko)

`deploy.ps1` → `npx tauri build` → dono agents **same** `target/release/` me
likhte hain. Do builds overlap kiye to:

- ek dusre ka `t9-editor-lit.exe` overwrite kar deta hai (jo install/stage
  hoga wo unpredictable hai),
- aur `tauri build` **"exit code -1"** dekar fail ho jaata hai.

**Rule:** ek waqt me sirf ek `deploy.ps1`. Doosra agent build shuru karne se
pehle `Get-Process cargo,rustc` check kar le — process dikhe to wait kare.

**Ab ye automatic hai (20-10-20, 4:07 PM):** `deploy.ps1` khud `tools\build.ps1`
ko call karta hai, jo `src-tauri\target\.build-lock` par lock leta hai. Doosra
deploy/build **queue** me rukta hai (lock mile bina `dist/` ya `target/` ko
chhoota nahi). Manual `Get-Process` check ab safety-net hai, rule nahi. Aur agar
free RAM 2.5 GB se kam ho to build `CARGO_BUILD_JOBS=2` par chalta hai — slow,
par OOM se marta nahi.

Isi wajah se 20-10-20 ko do build overlap hue aur ek failed hua.

**Aur ek chhota saboot (Agent 6 ne fix kiya):** `src/lib/ipc.ts` me `greetingLines()`
ke baad ek extra `}` reh gaya tha — poora frontend build `TS1128` se fail ho raha
tha. **Sirf wo ek brace hataaya gaya hai**, `greetingLines()` wrapper bilkul
jaisa tha waisa chhoda hai. Agar tumne abhi us file me aur kuch likha hai to
apne build me pehle `npx tsc --noEmit -p tsconfig.json` chala lena.

---

## Agent 1 (this session) — "Rust media + disk transcript core"

**Lane:** Chunk 2 backend foundation — audio extraction/chunking, SQLite transcript store,
Tauri commands, IPC wrappers, transcript store, CutMode wiring.

**Status:** Chunk 2 complete + Chunk 3 complete + Chunk 4 Smart Export complete (start_export/cancel_export + Stage Export button + light-file direct re-encode ≤200 MB/≤5 min skipping keyframe scan + SQLite ffprobe cache keyed by path+size+mtime). Committed as a03aff8 "feat(core): SQLite ffprobe cache + light-file export optimization".

**Files owned (editing):**

- `src-tauri/Cargo.toml` (added rusqlite)
- `src-tauri/src/lib.rs` (command surface)
- `src-tauri/src/audio.rs` (new)
- `src-tauri/src/transcript.rs` (new)
- `src-tauri/src/media.rs` (media_cache schema + probe_cached)
- `src-tauri/src/export.rs` (light file optimization)
- `src/lib/types.ts` (AudioChunk)
- `src/lib/ipc.ts` (new wrappers)
- `src/lib/stores/transcript.svelte.ts` (new)
- `src/lib/components/modes/CutMode.svelte` (transcript render + toggle)
- `docs/AGENT_STATUS.md`

**Do NOT touch (other agents may own):**

- `src/lib/components/clipchamp/**` shell layout

**Contracts exposed for other agents:**

- Rust: `extract_audio_chunks`, `default_db_path`, `default_chunk_dir`,
  `load_transcript`, `save_transcript`, `set_transcript_keep`
- TS: `extractAudioChunks`, `defaultDbPath`, `defaultChunkDir`, `loadTranscript`,
  `saveTranscript`, `setTranscriptKeep`, store `transcript`
- SQLite schema: `transcripts(source_path, id, start_secs, end_secs, text, keep, flag)`

---

## Agent 4 (this session) — "Go daemon: Telegram MTProto live transport (Chunk 5)"

**Lane:** `go/internal/vault`, `go/internal/api` vault endpoints, `go/internal/model`,
`go/internal/config`, `go/cmd/t9cloud`.

**Status:** Chunk 5 backend complete. `vault.Uploader` is now a real `gotd/td`
transport: QR authorisation (no OTP), a connection pool of n sockets, streaming
sends with 512 KB buffers, resume manifests keyed on SHA-256, peer resolution
for @username / t.me link / invite link / id / "me", byte-level progress.

**Files owned (editing):**

- `go/go.mod`, `go/go.sum` (added `github.com/gotd/td v0.129.0` + deps)
- `go/internal/vault/*.go` (new: digest, login, manifest, target, telegram)
- `go/internal/vault/vault.go` (orchestration, Batcher, Progress)
- `go/internal/api/server.go` (QR endpoints + status + progress wiring)
- `go/internal/api/store.go` (progressVault, finishVault)
- `go/internal/model/model.go` (VaultProgress)
- `go/internal/config/config.go` (dropped TELEGRAM_PHONE, added TELEGRAM_2FA_PASSWORD / TELEGRAM_CONNECTIONS)
- `go/cmd/t9cloud/main.go` (real buildVault)
- `go/README.md`, `docs/TELEGRAM_INTEGRATION_T_DUBBER.md`, `docs/ARCHITECTURE.md`
- `.env.example`, `.github/workflows/ci.yml`, `go/Makefile`

**Do NOT touch (other agents may own):**

- `src/**`, `src-tauri/**` (frontend IPC/types are Agent 1's lane)
- `src/lib/components/clipchamp/**`

**Contracts exposed for other agents:**

- HTTP: `GET /v1/vault/status`, `POST /v1/vault/authorise` (-> `{id,url,expires_unix,phase,rotations}`),
  `GET /v1/vault/authorise/{id}` (poll), `POST /v1/vault/upload` (-> job, progress via `GET /v1/jobs/{id}`).
- Progress payload on a vault job: `vault_progress` (bytes_done, bytes_total, bytes_per_sec, parts_done, part_count, phase, connections).
- Env: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_TARGET_CHAT`, `TELEGRAM_2FA_PASSWORD`, `TELEGRAM_CONNECTIONS`, `T9CLOUD_SESSION_DIR`.

**Next handoff:** Frontend IPC wrappers for the four endpoints and the QR card in
PolishMode, plus re-measuring the bandwidth-delay claim on a real uplink.

**Next handoff:** Frontend transcription orchestration should call
`extractAudioChunks` then POST chunks to `t9cloud /v1/transcribe`, then
`saveTranscript`. Virtual scroll + waveform remain Chunk 3.

---

## Agent 2 (this session) — "Audio waveform + thumbnail caching engine"

**Lane:** Chunk 3 timeline visuals — waveform peaks, ~1 fps JPEG strip, disk cache,
Tauri commands, IPC wrappers, timeline store, `Timeline.svelte` track rendering.

**Status:** Complete (reconciled). The waveform path was implemented in parallel
by Agent 1 (Chunk 3) and Agent 2; the two were merged onto a single
`WaveformData` + `extract` + JSON-on-disk design, with the split-bytes carry
fix applied to `PeakFolder`. Verified end-to-end against a synthetic 12 s
clip: 200 waveform bars with real peaks, 12 thumbnails at 160×90, cache reuse.
`cargo test --lib` → 40 passed (2 `export::` failures are Agent 1's Chunk 4,
unrelated); `node --test` → 8 passed; `svelte-check` clean in my files;
`prettier --check` clean.

**Files owned (editing):**

- `src-tauri/src/cache.rs` (new) — content-addressed cache keys + paths
- `src-tauri/src/waveform.rs` (new) — streaming PCM → normalized peaks
- `src-tauri/src/thumbnail.rs` (new) — 1 fps JPEG strip + manifest
- `src-tauri/src/lib.rs` (added `default_cache_dir`, `extract_waveform`, `extract_thumbnails`)
- `src/lib/types.ts` (WaveformData, ThumbnailStrip)
- `src/lib/ipc.ts` (`extractWaveform`, `extractThumbnails`, `defaultCacheDir`)
- `src/lib/timeline-utils.ts` + `src/lib/timeline.test.ts` (new)
- `src/lib/stores/timeline.svelte.ts` (new)
- `src/lib/components/clipchamp/Timeline.svelte` (track area)
- `docs/AGENT_STATUS.md`

**Contracts exposed:**

- Rust: `default_cache_dir`, `extract_waveform`, `extract_thumbnails`
- TS: `defaultCacheDir`, `extractWaveform`, `extractThumbnails`, store `timeline`
- Cache layout: `<app_data>/cache/waveform/<key>.json`,
  `<app_data>/cache/thumbs/<key>/thumb_%05d.jpg`

**Next handoff:** The timeline renders the waveform + strip. Player sync
(Agent 1) can draw a playhead from `player.currentTime` over the same
`durationSecs` without touching the cache.

---

## Agent 3 (this session) � Chunk 3 repair + verification

**Lane:** Reconciled the Chunk 3 waveform contract after a destructive overwrite of src-tauri/src/waveform.rs, and closed the remaining Chunk 3 gaps (transport wiring, X/V shortcuts, live time readout).

**Status:** `npm run verify:fast` green � prettier clean, svelte-check 0 errors/warnings, node --test 14/14 pass, cargo check clean (only benign dead-code warnings). `cargo test --lib waveform` → 5/5 pass.

**Files touched:**

- src-tauri/src/waveform.rs � restored WaveformData + extract() with PeakFolder streaming internals + JSON-on-disk cache (cache key via cache::source_key).
- src-tauri/src/lib.rs � added pub use waveform::WaveformData, added extract_waveform command, removed stale waveform_peaks handler entry.
- src/lib/types.ts � added WaveformData mirror.
- src/lib/components/clipchamp/Timeline.svelte � wired transport buttons (seek-to-start, �5s, play/pause), live playhead readout, play/pause icon swap.
- src/lib/components/modes/CutMode.svelte � X (cut) / V (keep) shortcuts on the transcript line under the playhead.

**Contracts unchanged:** default_cache_dir, extract_waveform, extract_thumbnails, store `timeline`, store `player`.
