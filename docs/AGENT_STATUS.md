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

---

## Agent backend-finish (this session) — Go daemon: key probe wired (`POST /v1/keys/probe`)

**Lane:** `go/**` only. The user asked this session to finish the other agent's
pending backend work; the frontend WIP visible in the tree was left untouched.

**Status:** Complete. `gofmt -l .` clean - `go vet ./...` clean -
`go test ./...` green across every package (api, cloud, vault, queue, config).

**What was pending:** an untracked `go/internal/cloud/probe.go` holding
`GroqClient.Probe` / `GeminiClient.Probe` ("does this key still work?" via one
models-list call) that nothing called, with no tests, plus a real defect: when
the client URL did NOT carry the literal `/audio/transcriptions` suffix
(test stub, proxy), the derivation silently fell back to the live
`api.groq.com` host, so an override never actually took effect.

**Files owned (editing):**

- `go/internal/cloud/probe.go` — completing the other session's file: the
  base-derivation fix (override respected exactly as given) plus doc updates.
- `go/internal/api/keys_probe.go` (new) — the `POST /v1/keys/probe` handler.
  Body key is used for one call, never logged or echoed; an empty body key
  re-verifies the daemon's configured key; guards the dependency, not the
  config flag (house rule).
- `go/internal/api/keys_probe_test.go` (new) — 13 tests: body key vs
  configured key, the 401 / 403 / 429 / 500 / 4xx verdict branches, the
  160-character echo cut, nil-client answers, unknown / missing service,
  GET 405, and "the response never contains the key".
- `go/internal/api/server.go` — one additive route block (comment + `POST /v1/keys/probe`).
- `Clipchamp_Bunny/docs/MEMORY.md` — one row in the backend-seam table.
- `docs/AGENT_STATUS.md` — this entry.

**Contract exposed (for the UI lane to plug into later):**

- HTTP `POST /v1/keys/probe` body `{"service":"groq"|"gemini","key":"..."}`;
  reply `{"ok":bool,"detail":"human sentence"}`, always 200 — only a
  malformed body or an unknown service is a 400. A probe that reports a dead
  key is still a successful probe.
- Frontend has no "Save & Test" card yet; building it is a UI-agent lane, not
  this one.

**Shipping note:** delivered as a LOCAL COMMIT only — `git push` was not run
(the mandatory worklog rule). The daemon reaches the desktop through the next
`-Ci` deploy; `tools/go-build-id.ps1` recomputes its hash automatically.

---

## 2026-10-23 - Agent backend-finish - Telegram vault RESTORE (the read half)

**Task:** the repo's last backend TODO - "Telegram vault -> media library"
(MEMORY.md seam table): the daemon stored five-gigabyte backups but had no way
to bring one back out of Telegram.

**Status:** Complete, verified offline (`gofmt -l` clean, `go vet` clean,
go test green; see the pass note below). Delivered as LOCAL COMMIT only -
no push, per the worklog rule.

**Design (mirrors the upload, and trusts nothing but a digest):**

- `vault.Restore(ctx, manifest, destDir)`: preflight -> fetch -> join. The
  upload's manifest (digests + message ids) is the whole input contract.
- `telegram.FetchParts` implements the new `vault.Fetcher` interface
  (compile-time proof in telegram.go): one `client.Pool(n)` per run, one
  worker per connection, each part streamed through gotd's `downloader`
  (512 KB chunks, FLOOD_WAIT honoured) into `.t9restore-<name>.<idx>.tmp`
  beside the destination; bytes counted and SHA-256'd in the same pass
  (no second read). A short stream, a digest mismatch, or a CDN
  `RedirectError` deletes the temp file and refuses with a sentence.
- Per-restore resume record `restore-*.json`, rewritten after every verified
  part - an interruption costs one part, like uploads. A temp file survives a
  resume only when exact size AND a fresh digest both pass - the join then
  concatenates parts in order with a 256 KB buffer and demands the final size
  equal the manifest's source size, else the file is removed. The destination
  is never touched until every byte is proven.
- Progress on the existing VaultProgress payload with new phases
  verifying -> downloading -> joining -> done; byte total stays monotonic
  (the preflight's verified bytes are handed to the transport as base).

**New HTTP seam (guards the dependency, not a config flag):**

- `GET /v1/vault/manifests` - the restore menu: completed uploads, newest
  first; an empty list, not an error, before Telegram is configured.
- `POST /v1/vault/download` body `{"source_path","dest_dir"}` -> 202 job of
  kind `restore`; 404 for a source the vault never backed up; 503 without a
  transport or session; the chat comes from the manifest, not
  TELEGRAM_TARGET_CHAT; a browser hang-up cannot kill a running download
  (`context.WithoutCancel`, same rule as uploads).

**Files owned:**

- `go/internal/vault/restore.go` (new) - planner, restore store, stored
  backups listing, restore progress tracker, `PrepareManifest` for tests.
- `go/internal/vault/telegram.go` - `FetchParts` + `fetchPart` +
  `messageDocument` (channels.getMessages vs messages.getMessages by peer
  type) + `digestWriter`.
- `go/internal/vault/restore_test.go` (new) - 13 offline tests: two round
  trips with byte equality and progress phases, both resume rules, digest /
  truncation / rot-at-join refusals, incomplete vault, no-fetcher refusal,
  idempotency, overwrite refusal, name sanitising, the restore menu.
- `go/internal/api/vault_restore.go` (new) + two routes in server.go +
  `finishRestore` in store.go.
- `go/internal/api/vault_restore_test.go` (new) - 6 endpoint tests: empty
  menu before Telegram exists, prepared manifest listed, field guards
  (400), unauthorised 503, unknown source 404, 202 job of kind restore that
  fails honestly on a transport without the capability.
- `go/internal/model/model.go` - `JobRestore`, `VaultResult.Destination`
  (omitempty), `Percent` covers restore jobs.
- `docs/TELEGRAM_INTEGRATION_T_DUBBER.md` - restore row in the status table.
- `Clipchamp_Bunny/docs/MEMORY.md` - seam row flipped to backend-done.

**Not verified online:** a real-account download (measured throughput, the
CDN refusal against a live redirect) - same honesty line as every other
vault row. The UI "restore into library" button is frontend work, not this
lane.
