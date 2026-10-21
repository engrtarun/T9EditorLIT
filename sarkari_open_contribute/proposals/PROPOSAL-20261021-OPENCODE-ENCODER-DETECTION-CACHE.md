# Sarkari Proposal: Cache Hardware Encoder Detection

- **Proposal ID:** `PROPOSAL-20261021-OPENCODE-ENCODER-DETECTION-CACHE`
- **Author Agent:** `opencode/beam-free`
- **Date Staged:** `2026-10-21`
- **Target Subsystem:** `Rust Backend (src-tauri/src/ffmpeg.rs)`
- **Status:** `APPROVED_AND_APPLIED`

## Why this file was created

`ffmpeg_has_encoder` runs `ffmpeg -encoders` every time. Hardware support is checked repeatedly during export planning. This spawns extra child processes and slows UI.

## Why this is necessary

Encoder capability does not change during a run. Caching avoids repeated probes and reduces CPU/disk work.

## 1. Problem Statement

- `HardwareSupport::detect()` calls `ffmpeg_has_encoder` 3 times.
- Export planning may call detection again.
- Each call spawns FFmpeg and parses output.

## 2. Proposed Solution

- Cache `HardwareSupport` in Tauri managed state.
- Detect once at app startup or first export.
- Reuse cached result for all planning/export calls.

## 3. Zero-RAM & Resource Impact

- Small cached struct.
- Fewer FFmpeg child processes.
- Faster export planning.

## 4. Banned Tech Compliance

- [x] Zero Python.
- [x] Rust only.

## 5. Verification & Rollback

- `npm run verify:fast`
- Test export planning twice; second should not spawn probes.
- Rollback: revert cache.

## User Sanction

```text
[ ] APPROVED
[ ] REJECTED
[ ] REVISION REQUESTED
```

---

**Decision (2026-10-21, user-sanctioned delegation).** The user wrote:

> "in 5 ke best ko chuno or karo / other agents work deploy"

The user is the only approver (CONTRIBUTING_RULES rule 4); this records the
user's choice of the best option for each of the five open decisions rather
than an agent approving its own work. Where a self-approval would have been
required, the proposal stays pending and says so.

---

### The premise was checked, and the proposal is right

`ffmpeg_has_encoder` in `src-tauri/src/ffmpeg.rs` runs `ffmpeg -encoders` on
**every** call - a fresh child process each time. `HardwareSupport::detect()`
calls it three times (`h264_qsv`, `h264_nvenc`, `h264_amf`) and `export.rs`
calls it again at three more sites while choosing an encoder chain. The same
file already caches its _other_ probe (`TESTED`, line 314) because someone
already learned this lesson once - they just did not apply it to the listing.

### What was applied

`src-tauri/src/ffmpeg.rs` gained a `OnceLock<Option<String>>` holding the
`-encoders` listing, fetched once by `encoders_listing()`. `ffmpeg_has_encoder`
now searches that cached text instead of starting a child process, so
`HardwareSupport::detect()` went from three spawns to one fetch, and the three
`export.rs` sites became free. The "no FFmpeg on this machine" result is
cached too, because that is a fact about the machine rather than a transient
error.

### Verified

`cargo check --tests` exit 0, `cargo test` exit 0, `npm run lint` exit 0.
