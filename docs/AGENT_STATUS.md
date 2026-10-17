# Agent Worklog / Coordination

This file is the shared handoff board for parallel agents. Update it before and after
touching a lane so two agents never edit the same files.

## ⚠️ Mandatory Agent Git Rule

1. **Commit locally upon finishing:** When your work passes `npm run verify:fast`, make a local git commit with your agent name:
   `git commit -m "feat(<scope>): <description>" --author="Agent <YourName> <agent@local>"`
2. **DO NOT PUSH:** Agents must **NEVER** run `git push`. Pushing to remote is reserved exclusively for the human user.

## Agent 1 (this session) — "Rust media + disk transcript core"

**Lane:** Chunk 2 backend foundation — audio extraction/chunking, SQLite transcript store,
Tauri commands, IPC wrappers, transcript store, CutMode wiring.

**Status:** Chunk 2 complete + Chunk 3 complete + Chunk 4 Smart Export wired (start_export/cancel_export + Stage Export button).

**Files owned (editing):**

- `src-tauri/Cargo.toml` (added rusqlite)
- `src-tauri/src/lib.rs` (command surface)
- `src-tauri/src/audio.rs` (new)
- `src-tauri/src/transcript.rs` (new)
- `src/lib/types.ts` (AudioChunk)
- `src/lib/ipc.ts` (new wrappers)
- `src/lib/stores/transcript.svelte.ts` (new)
- `src/lib/components/modes/CutMode.svelte` (transcript render + toggle)
- `docs/AGENT_STATUS.md`

**Do NOT touch (other agents may own):**

- `src/lib/components/clipchamp/**` shell layout
- Export pipeline (Chunk 4) — not started

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
