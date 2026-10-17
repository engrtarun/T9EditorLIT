# AGENTS.md — Rules & Architecture for AI Agents in T9EditorLIT

Welcome, AI Agent. Read this document before inspecting, modifying, or generating any code in this repository.

---

## 1. The Core Constraint: Zero-RAM Footprint

**Target Machine:** Windows 11, Intel Core i3, 8 GB RAM (~80% already utilized by the OS).  
**Primary Directive:** **Nothing large is ever resident in RAM.**

- **Never** buffer entire media files (1080p/4K 60fps, 5 GB+) into memory.
- All media inspection, chunking, and cutting happens via **FFmpeg/FFprobe child processes** that are hard-killed immediately when done.
- State (transcripts, cut decisions) lives in **SQLite on disk**, never in the heap.
- UI uses **Mode-Based Panel Isolation**: Switching modes unmounts and destroys the previous component tree via `{#key}`.

---

## 2. Permitted Tech Stack (And What is BANNED)

| Layer                | Permitted Technology                             | Prohibited                                    |
| :------------------- | :----------------------------------------------- | :-------------------------------------------- |
| **Frontend UI**      | TypeScript, Svelte 5, Tailwind 4                 | Tailwind v3, React, heavy component libraries |
| **Desktop Core**     | Rust (Tauri v2)                                  | C++, Python, Electron                         |
| **Media Operations** | FFmpeg / FFprobe child processes                 | Direct in-memory frame decoders               |
| **Cloud Worker**     | Go (`go/` — `t9cloud` daemon on 127.0.0.1)       | External public servers, Node microservices   |
| **Python**           | **STRICTLY BANNED** across the entire repository | **NO Python, no pip, no venv**                |

---

## 3. Telegram Vault Logic & External Submodule (`T_Dubber`)

- **Submodule Reference:** [`modules/T_Dubber`](modules/T_Dubber/README.md) (`https://github.com/engrtarun/T_Dubber`)
- **Status:** Remote reference only. **DO NOT** run `git submodule update --init` locally, as cloning its assets would consume gigabytes of disk and memory.
- **Where to get Telegram logic:**
  - Read [`docs/TELEGRAM_INTEGRATION_T_DUBBER.md`](docs/TELEGRAM_INTEGRATION_T_DUBBER.md).
  - Port logic from `T_Dubber`'s `TGUP.md` and Go MTProto client pool into **Go (`go/internal/vault`)** or **Rust (`grammers`)**.
  - **Never** copy Python Telethon code. Adapt all algorithms to Go or Rust.
  - Implement 1.9 GB split chunking and concurrent socket pools (3-4 MTProto clients) to maximize bandwidth.

---

## 4. Layer Boundaries & IPC Rules

```
┌──────────────────────────────────────────────┐
│ Svelte 5 components (src/lib/components/)    │  NEVER call invoke() directly
├──────────────────────────────────────────────┤
│ lib/ipc.ts                                   │  Single typed choke point
├──────────────────────────────────────────────┤
│ #[tauri::command] in src-tauri/src/lib.rs    │  Signatures only, no business logic
├──────────────────────────────────────────────┤
│ media.rs · ffmpeg.rs · memory.rs             │  Pure Rust logic, unit-tested
├──────────────────────────────────────────────┤
│ t9cloud Go daemon (127.0.0.1:8787)           │  Groq Whisper, Gemini flags, Telegram MTProto
└──────────────────────────────────────────────┘
```

1. Frontend components must only call functions exported from [`src/lib/ipc.ts`](src/lib/ipc.ts).
2. `lib.rs` in Rust holds only command declarations. Pure logic must live in separate, unit-testable modules.
3. Serde uses `rename_all = "camelCase"` on every struct crossing IPC; [`types.ts`](src/lib/types.ts) must mirror Rust structs exactly.

---

## 5. Verification Before Handing Over

Before declaring any task complete, verify your work:

```powershell
npm run verify:fast  # prettier + svelte-check + node --test + cargo check (~1 min)
```

Or the individual pieces:

```powershell
npm run check    # svelte-check + tsc (must find 0 errors)
npm run lint     # prettier check
npm run test     # node --test (built-in runner, no framework)
```

If editing Go code:

```bash
cd go && gofmt -l . && go vet ./... && go test ./...
```
