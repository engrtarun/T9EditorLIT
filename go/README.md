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
authorise again. A long-lived daemon keeps that session alive on disk. That is the
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

| Method | Path                       | Purpose                                              |
| ------ | -------------------------- | ---------------------------------------------------- |
| `GET`  | `/healthz`                 | Liveness, queue depth, which pipelines are ready     |
| `POST` | `/v1/transcribe`           | Queue a transcription over a list of audio chunks    |
| `POST` | `/v1/analyze`              | Queue Gemini retake/wrong-example detection          |
| `GET`  | `/v1/vault/status`         | Whether the stored Telegram session still works      |
| `POST` | `/v1/vault/authorise`      | Start a QR login; returns the `tg://login` URL       |
| `GET`  | `/v1/vault/authorise/{id}` | Poll that login for phase, current code and rotation |
| `POST` | `/v1/vault/upload`         | Queue a Telegram backup of a file path               |
| `GET`  | `/v1/jobs/{id}`            | Poll job state, progress and results                 |

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
| `T9CLOUD_SESSION_DIR`    | `$T9EDITOR_DATA_DIR/telegram` | MTProto session + resume manifests        |

The one third-party dependency is `github.com/gotd/td`, the MTProto client. It is
the reason the vault exists in Go at all: writing an MTProto implementation — the
auth key exchange, the DC migration, the salted encryption — is not something to
attempt when the language was chosen for something else entirely.

## The Telegram vault

**Split, hash, send, record.** A 5 GB source exceeds Telegram's 2 GB per-file
ceiling, so it is sent as three 1.9 GB parts. Before anything moves, every part is
hashed with a streaming SHA-256 and the digests go into a manifest that is
rewritten on disk after each part lands. That is what makes an interrupted run
cost one part instead of 5 GB — and what lets a restore verify the bytes it got
back.

**Three connections, not three goroutines.** One TCP socket cannot fill a home
uplink: T_Dubber measured 2.06 MB/s on a 3.76 MB/s line because a single MTProto
connection's window (~232 KB) is smaller than the bandwidth-delay product
(~404 KB at 110 ms RTT). Goroutines on one client share that window and change
nothing. Separate _connections_ each carry their own, which is why the pool is the
mechanism and `TELEGRAM_CONNECTIONS` exists.

**Nothing is buffered.** A part is an `io.SectionReader` over its own file handle,
read by gotd's uploader in 512 KB × 3 buffers. Peak upload memory is about
1.5 MB per connection — a 1.9 GB part costs the same as a 512 KB one, and hashing
uses a fixed 512 KB buffer per part. The target machine has 8 GB of RAM that is
already 80% occupied.

**Authorisation is a QR scan, never an OTP.** `auth.exportLoginToken` is the same
call Telegram Desktop makes for "Link Desktop Device": the daemon returns a
`tg://login?token=…` URL, the app renders it as a QR, the phone scans and taps
confirm. No phone number is stored and no login code is ever requested — so an
abandoned attempt costs nothing. Two-Step Verification is the one case a scan does
not cover; `TELEGRAM_2FA_PASSWORD` answers it, or the API says so plainly rather
than stalling.

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

| Piece                                              | State                   |
| -------------------------------------------------- | ----------------------- |
| Bounded queue with retry/backoff                   | ✅ done, tested         |
| Groq Whisper client (streaming, offset timestamps) | ✅ done, tested         |
| Gemini analysis + `✕` flag parsing                 | ✅ done, tested         |
| Telegram split planner (1.9 GB parts)              | ✅ done, tested         |
| MTProto transport (pool, streaming, resume)        | ✅ done, tested offline |
| QR authorisation, no OTP                           | ✅ done, tested offline |

The vault unit tests run entirely offline: they cover the split, the digests, the
resume manifests, peer parsing and the progress accounting. The two things that
cannot be tested without a Telegram account are the handshake itself and the
measured throughput, so those are documented claims, not verified ones —
`go build` proves the wiring, not the speed.
