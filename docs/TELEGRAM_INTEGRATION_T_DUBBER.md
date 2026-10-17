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
  - MTProto sessions are **stateful** (require phone number + 2FA / OTP authentication).
  - If the desktop app held the session directly in-memory, closing the window would drop the session and force an OTP prompt on every restart.
  - The long-lived Go daemon (`t9cloud`) stores the authenticated session on disk (`T9CLOUD_SESSION_DIR`) and keeps it valid across UI reloads.

### D. SHA-256 Digest Verification

- Every split part must calculate a streaming SHA-256 hash before and during upload.
- Manifest with hashes is saved so any download / restoration (`fetch`) can verify part integrity before re-joining.

---

## 4. Chunk 5 Implementation Checklist for Agents

When implementing **Chunk 5**, follow these exact steps:

1. **Daemon Endpoint (`go/internal/vault`)**:
   - Complete `vault.Uploader` interface using Go MTProto client (`gotd/td`) or Rust child process (`grammers`).
   - Wire `POST /v1/vault/authorise` (for OTP/session creation).
   - Wire `POST /v1/vault/upload` (accepts file path, calls `vault.Plan()`, dispatches parallel parts).
2. **IPC Integration (`src/lib/ipc.ts`)**:
   - Add typed wrapper functions calling `t9cloud` loopback HTTP API (`http://127.0.0.1:8787/v1/vault/...`).
3. **Frontend UI ([PolishMode.svelte](file:///c:/Users/pocot/Music/T9EditorLIT/src/lib/components/modes/PolishMode.svelte))**:
   - Add "Backup to Telegram Vault" card with live upload progress, part count, and connection status.
