# Telegram MTProto Vault — Logic Extraction from T_Dubber

> **Reference Repository:** [https://github.com/engrtarun/T_Dubber](https://github.com/engrtarun/T_Dubber)  
> **Submodule Location:** `modules/T_Dubber` (registered in `.gitmodules`, kept un-cloned locally to save RAM/disk)  
> **Target Seam in T9EditorLIT:** [`go/internal/vault`](../go/internal/vault) (`t9cloud` Go daemon) & `src-tauri` (Rust)

---

## 1. Context & Motivation

In **Chunk 5**, T9EditorLIT provides a **Cloud Vault** to automatically back up 5 GB / 2-hour video tutorials to Telegram without hitting the Bot API's 50 MB limit or choking user bandwidth.

The proven architecture for this is documented and implemented in Tarun's companion project: **[T_Dubber](https://github.com/engrtarun/T_Dubber)**.

---

## 2. ⚠️ MANDATORY RULES FOR ALL AI AGENTS

1. **PYTHON IS STRICTLY BANNED in T9EditorLIT**:
   - `T_Dubber` contains legacy Python (`Telethon`, `app.py`, `telegram_uploader.py`).
   - **DO NOT port or write any Python code into T9EditorLIT.**
   - All logic must be written in **Go** (for the `t9cloud` daemon), **Rust**, or **TypeScript**.
   - No Python runtimes, venvs, or pip packages are allowed.

2. **Zero-RAM Footprint**:
   - Never load entire 2 GB or 5 GB video files into memory.
   - Files are sliced via disk offsets (`io.NewSectionReader` in Go or streaming file handles in Rust).
   - Only small stream buffers (< 512 KB per connection) may reside in RAM.

3. **Remote Reference Only**:
   - Do not pull the heavy assets of `T_Dubber` into the local workspace.
   - If you need to view raw code from `T_Dubber`, fetch only specific files from GitHub (`https://raw.githubusercontent.com/engrtarun/T_Dubber/main/...`).

---

## 3. Core Logic Extracted from T_Dubber

### A. The 2 GB MTProto Ceiling & Chunking (`TGUP.md`)

- Telegram's MTProto protocol allows individual files up to **2.00 GB** for regular accounts.
- Files larger than 2 GB must be split into parts before uploading.
- **Safety Margin:** Parts must be sized at **≤ 1.90 GB** (`1_900_000_000` bytes) to prevent boundary rounding errors from triggering Telegram rejection.
- This is already implemented and unit-tested in [`go/internal/vault/vault.go`](../go/internal/vault/vault.go):
  ```go
  const (
      MaxTelegramFileBytes = 2_000_000_000
      DefaultPartBytes     = 1_900_000_000
  )
  ```

### B. The Bandwidth–Delay Product (BDP) Problem

In `T_Dubber`, network analysis revealed:

- **Observed single-socket upload:** ~2.06 MB/s on a 3.76 MB/s uplink (55% utilization).
- **Reason:** Single TCP socket window size (~232 KB) over ~110 ms RTT cannot fill the pipe.
- **The Solution:** A **pool of parallel MTProto client connections (3 to 4 connections)** sharing the exact same session credentials.
- In Go (`gotd/td`):
  - Goroutines alone do **not** fix this if they share one client instance (they share one TCP window).
  - You must open a **pool of separate client instances**, each pointing to the same disk-backed auth session file.
  - Each client connection streams a different chunk or part concurrently.

### C. Stateful MTProto Session Management

- Why Telegram upload belongs to `t9cloud` (Go daemon):
  - Desktop apps (Tauri/WebView) can be closed or restarted by the user.
  - MTProto sessions are **stateful** (they hold an auth key that outlives any
    single request).
  - If the desktop app held the session directly in-memory, closing the window
    would drop the session and force a fresh authorisation on every restart.
  - The long-lived Go daemon (`t9cloud`) stores the session on disk
    (`T9CLOUD_SESSION_DIR`) and keeps it valid across UI reloads.

### D. SHA-256 Digest Verification

- Every split part must calculate a streaming SHA-256 hash before and during
  upload.
- Manifest with hashes is saved so any download / restoration (`fetch`) can
  verify part integrity before re-joining.

---

## 4. Authorisation: QR scan, never an OTP

**This section is the one decision that diverges from `tgup`, and it is
deliberate.**

`tgup` refuses to start a code-based auth flow on a machine with no console,
because Telegram sends the login code **the moment the flow begins** and a
headless run can only fail at EOF — after spending a real code on the user's
phone for nothing. `tgup`'s answer is to refuse and let Telethon fall back.

A daemon has no fallback, so refusing is not enough. This implementation uses
the flow Telegram Desktop itself uses for **Settings → Devices → Link Desktop
Device**:

1. The daemon calls `auth.exportLoginToken` — which is _meant_ to be called
   while unauthorised.
2. It returns a token, handed to the app as `tg://login?token=…`.
3. The desktop app renders it as a QR.
4. The user's already-logged-in phone scans it and taps confirm. **That tap is
   the second factor.**
5. Telegram pushes `updateLoginToken`; the auth key the daemon is already
   connected with becomes authorised.

**There is no phone number setting, and no login code is ever requested.** An
abandoned attempt therefore costs nothing — which is the guarantee `tgup` was
reaching for, obtained without the refusal.

The token rotates every ~30 seconds and asking for a new one invalidates the
old, so the daemon re-exports and re-exposes it. The UI must redraw when the URL
changes; the `rotations` field in `LoginChallenge` exists so it can tell that
apart from a QR that simply is not being scanned.

**Two-Step Verification is the one thing a scan does not cover.** With 2FA on,
Telegram answers `auth.exportLoginToken` itself with `SESSION_PASSWORD_NEEDED`,
_before_ any QR is drawn. The daemon answers that with `TELEGRAM_2FA_PASSWORD`
if one is configured, and otherwise reports `password_needed` rather than
pretending to wait. It never prompts: a prompt a daemon cannot show is worse
than a clear refusal.

---

## 5. Chunk 5 Implementation Checklist for Agents

When implementing **Chunk 5**, follow these exact steps:

1. **Daemon Endpoint (`go/internal/vault`)**:
   - Complete `vault.Uploader` interface using Go MTProto client (`gotd/td`).
   - Wire `POST /v1/vault/authorise` (starts a QR login) and
     `GET /v1/vault/authorise/{id}` (polls it).
   - Wire `GET /v1/vault/status` (does the stored session still work?).
   - Wire `POST /v1/vault/upload` (accepts a file path, hashes it, dispatches
     parts across the connection pool, records a resume manifest).
2. **IPC Integration (`src/lib/ipc.ts`)**:
   - Add typed wrapper functions calling `t9cloud` loopback HTTP API
     (`http://127.0.0.1:8787/v1/vault/...`).
3. **Frontend UI (`src/lib/components/modes/PolishMode.svelte`)**:
   - Add "Backup to Telegram Vault" card with live upload progress, part count,
     and connection status.
   - Render the login QR from `LoginChallenge.url` and poll
     `GET /v1/vault/authorise/{id}`, redrawing when the URL changes.

---

## 6. What landed, and what is still a claim

Implemented in `go/internal/vault`, offline-tested:

| Piece                | Where         | Notes                                                           |
| -------------------- | ------------- | --------------------------------------------------------------- |
| 1.9 GB split planner | `vault.go`    | 5 GB → 3 parts, exact tiling, no overflow past the 2 GB ceiling |
| Streaming SHA-256    | `digest.go`   | 512 KB buffer per part, independent handle per range            |
| Resume manifest      | `manifest.go` | Rewritten after each part; a changed digest invalidates it      |
| Connection pool      | `telegram.go` | `client.Pool(n)` — n sockets, one auth key, n parts in flight   |
| QR authorisation     | `login.go`    | No phone number, no code, 2FA handled or reported               |
| Peer resolution      | `target.go`   | @username, t.me link, invite link, `-100…` id, `me`             |

**Verified by tests:** the split, the digests, resume behaviour including the
changed-file case, concurrent hashing, progress accounting, and every refusal
path. **Not verified:** the MTProto handshake itself and the measured throughput.
Both need a real account; `go build` proves the wiring, not the speed. The
bandwidth-delay argument for three connections is inherited from `tgup`'s
measurements and has not been re-measured on this machine.
