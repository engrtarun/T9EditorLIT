# t9cloud — the Go cloud worker daemon

The desktop app is deliberately local. This daemon is the part that is not, and it
owns only the work that genuinely should not live in a window the user can close.

```
┌─────────────────────────┐        HTTP on 127.0.0.1        ┌──────────────────┐
│  T9EditorLIT (Tauri)    │ ──────────────────────────────▶ │  t9cloud (Go)    │
│  • ffprobe / ffmpeg     │   chunk paths, segment JSON     │  • Groq Whisper  │
│  • cutting / export     │ ◀────────────────────────────── │  • Gemini flags  │
│  • SQLite (state)       │        jobs, transcripts        │  • Telegram vault│
└─────────────────────────┘                                 └──────────────────┘
                    5 GB file never crosses this line
```

## Why this is a separate process at all

Exactly one reason, and it is a real one: **Telegram MTProto sessions are stateful.**

A desktop app that gets closed loses its authorised session, and the user has to
re-enter an OTP. A long-lived daemon keeps that session alive on disk. That is the
entire justification for a third language.

Everything else stays in Rust:

| Work                                | Owner         | Why                                     |
| ----------------------------------- | ------------- | --------------------------------------- |
| ffprobe / ffmpeg / cutting / export | Rust          | CPU- and disk-bound, needs process kill |
| Chunking audio into ≤15 MB pieces   | Rust          | Streams through FFmpeg, never buffers   |
| Transcript + ✓/✕ decisions          | Rust + SQLite | Disk-backed, must survive restarts      |
| Uploading each chunk to Groq        | **Go**        | Long-running, retryable, bounded queue  |
| Flagging retakes via Gemini         | **Go**        | Long-running, retryable                 |
| Holding the Telegram session        | **Go**        | Must outlive the app window             |

If someone later asks "why isn't this just all Rust?", the honest answer is that it
could be. The seam exists for the session.

## Design rules

**The 5 GB file never crosses the process boundary.** The app hands over _paths to
already-split audio chunks_, not bytes. The daemon streams each chunk to the
provider through an `io.Pipe` — it is never read whole into memory. On an 8 GB
machine that is the whole design.

**Backpressure, not unbounded buffering.** The queue is bounded. When it is full,
`POST /v1/transcribe` answers `429` instead of quietly growing. The client slows
down rather than the daemon swallowing the machine.

**Retry only what can succeed.** 429 and 5xx are retried with exponential backoff.
400 and 401 are not — a bad API key fails identically forever, and retrying only
burns the provider's rate limit.

**Partial beats failed.** One bad chunk out of forty does not throw away the
transcript; the job comes back `partial` with a note about which chunk failed.

**Loopback only, no authentication.** This daemon holds Groq, Gemini and Telegram
keys. It refuses to bind anything but a loopback address, checked twice — once in
`config`, once in `main` — so a future edit cannot silently widen its exposure.

## API

| Method | Path                  | Purpose                                               |
| ------ | --------------------- | ----------------------------------------------------- |
| `GET`  | `/healthz`            | Liveness, queue depth, which pipelines are configured |
| `POST` | `/v1/transcribe`      | Queue a transcription over a list of audio chunks     |
| `POST` | `/v1/analyze`         | Queue Gemini retake/wrong-example detection           |
| `POST` | `/v1/vault/upload`    | Queue a Telegram backup (Chunk 5)                     |
| `POST` | `/v1/vault/authorise` | Interactive MTProto login (Chunk 5)                   |
| `GET`  | `/v1/jobs/{id}`       | Poll job state, progress and results                  |

Transcribe request:

```json
{
  "source_path": "D:/videos/lecture.mp4",
  "chunks": [
    { "path": "D:/t9cache/audio/c000.m4a", "offset_secs": 0, "index": 0 },
    { "path": "D:/t9cache/audio/c001.m4a", "offset_secs": 897.5, "index": 1 }
  ],
  "language": "hi",
  "prompt": "Rust, Tauri, Svelte, ffmpeg"
}
```

The daemon offsets every returned timestamp by its chunk's `offset_secs`, so the
app always works in the original video's timeline and never thinks about chunks.

## Running it

```bash
make run                       # reads ./.env
make run-dev                   # debug logging
make build && ./bin/t9cloud    # compiled binary

t9cloud -env /path/to/.env
t9cloud -version
```

Configuration comes from the same `.env` as the desktop app, so keys live in one
place. See [`../.env.example`](../.env.example).

| Variable                 | Default                       | Meaning                                   |
| ------------------------ | ----------------------------- | ----------------------------------------- |
| `T9CLOUD_ADDR`           | `127.0.0.1:8787`              | Listen address. Non-loopback is rejected. |
| `T9CLOUD_WORKERS`        | `2`                           | Concurrent cloud jobs                     |
| `T9CLOUD_QUEUE_CAPACITY` | `32`                          | Pending jobs before `429`                 |
| `T9CLOUD_MAX_ATTEMPTS`   | `3`                           | Total tries per job                       |
| `T9CLOUD_BASE_BACKOFF`   | `1s`                          | First retry delay, doubling               |
| `T9CLOUD_SESSION_DIR`    | `$T9EDITOR_DATA_DIR/telegram` | MTProto session location                  |

Zero third-party dependencies — only the standard library. `go build` works offline
and CI needs no module cache.

## Development

```bash
make fmt      # gofmt -w
make lint     # gofmt check + go vet
make test     # unit tests
make race     # tests under the race detector
make check    # exactly what CI runs
make docker   # container image
```

## Status

| Piece                                              | State           |
| -------------------------------------------------- | --------------- |
| Bounded queue with retry/backoff                   | ✅ done, tested |
| Groq Whisper client (streaming, offset timestamps) | ✅ done, tested |
| Gemini analysis + `✕` flag parsing                 | ✅ done, tested |
| Telegram split planner                             | ✅ done, tested |
| MTProto transport                                  | ⬜ Chunk 5      |

The vault currently plans splits correctly and refuses uploads with
`ErrNotConfigured`. The MTProto transport slots in behind the `vault.Uploader`
interface without touching the API, the queue, or the tests above.
