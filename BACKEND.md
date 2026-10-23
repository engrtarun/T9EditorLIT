# BACKEND.md — T9 Cloud setup: backend work order (for the backend agent)

> **UPDATE (agent pass 2 — UI agent verified the backend):**
>
> **Done — Task 1 (real key probe).** `go/internal/api/keys_probe.go` +
> `go/internal/cloud/probe.go`: `POST /v1/keys/probe` with body
> `{"service":"groq"|"gemini","key":"…"}` → `{"ok":bool,"detail":"…"}`. Real
> models-list call, 12 s deadline, key never logged/echoed, unit tests present.
> The UI service layer (`Clipchamp_Bunny/src/lib/cloud.ts`) now calls this real
> endpoint. ✅
>
> **Still TODO — see Tasks 2, 3, 4, 5, and the BUG below.**
>
> 🔴 **BUG — first-time key test is blocked.** `handleKeysProbe` refuses with
> `"no Groq key is configured on this daemon (set GROQ_API_KEY in .env)"` when
> `deps.Groq == nil`. But `deps.Groq` / `deps.Gemini` are **only built in
> `cmd/t9cloud/main.go` when `cfg.HasGroq()` / `cfg.HasGemini()`** — i.e. when a
> key is _already_ set. So on a fresh machine (the whole point of the setup
> page) pasting your **first** key returns "not configured" instead of testing
> the pasted key. Fix: when the client is nil but a non-empty `key` is supplied
> in the request, build a throwaway client from `req.Key` and probe with that.
> Do **not** require a pre-configured key just to test a pasted one.

**Status:** Desktop UI for the T9 Cloud page ("Connect your workspace") is being
finalised by the UI agent. Per the user's directive, **localhost is dev/inspect
only** — all real backend + logic work is listed below and belongs to **you**.
Do not redesign the UI; the UI calls the contracts in §4 and shows honest
"not wired / not configured" states until you ship.

Read `AGENTS.md` first (rules, deploy protocol, banned tech). Summary that
applies to every task here:

- **Python is banned.** Backend = Go (`go/`) + Rust (`src-tauri/`).
- **Loopback only.** The daemon binds `127.0.0.1` (config refuses anything else).
- **Zero-RAM rule:** never buffer media; keys are small but never log them.
- **Never fake success.** "Connected" only after a real round-trip succeeded.
- **No local Rust release builds** (cargo shim: only `cargo check`). Go builds
  and tests run locally fine.
- **Ship via the ledger:** `pwsh -File tools\deploy.ps1 -Ci -Agent <you>
-Model <provider/model> -Task ... -Why ... -Scope go` (or `both`).

---

## 1. What already exists (do not rebuild)

### Go daemon `t9cloud` (`go/`, module `github.com/engrtarun/T9EditorLIT/go`)

Runs on `127.0.0.1:7878`, CORS `*`, version stamped via ldflags
(currently rolling as `go-<gohash>` from `tools/go-build-id.ps1`).

Routes in `go/internal/api/server.go`:

| Route                          | Returns                                               |
| ------------------------------ | ----------------------------------------------------- |
| `GET /healthz`                 | `model.Health` (shape below)                          |
| `POST /v1/transcribe`          | job (Groq Whisper)                                    |
| `POST /v1/correct`             | job (Groq autocorrect)                                |
| `POST /v1/analyze`             | job (Gemini flags)                                    |
| `GET /v1/greeting`             | cached greeting lines                                 |
| `POST /v1/vault/authorise`     | `vault.LoginChallenge` — **QR-only login, by design** |
| `GET /v1/vault/authorise/{id}` | `vault.LoginChallenge` poll (token rotates ~30 s)     |
| `GET /v1/vault/status`         | `vault.Status`                                        |
| `POST /v1/vault/upload`        | job (chunked MTProto upload)                          |
| `GET /v1/jobs/{id}`            | job state                                             |
| `GET /v1/net/speed`            | throughput probe                                      |

Config (`go/internal/config/config.go`): env vars and/or `.env`:
`GROQ_API_KEY`, `GROQ_CHAT_MODEL`, `GEMINI_API_KEY`, `GEMINI_MODEL`,
`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_2FA_PASSWORD`,
`TELEGRAM_TARGET_CHAT`, `T9EDITOR_DATA_DIR`.

`Config.Capabilities()` (the `cloud` map in `/healthz`):

```json
{
  "transcribe":  "ready" | "GROQ_API_KEY not set",
  "autocorrect": "ready" | "GROQ_CHAT_MODEL not set",
  "analyze":     "ready" | "GEMINI_API_KEY not set",
  "vault":       "ready" | "TELEGRAM_API_ID / API_HASH not set",
  "vault_upload": "ready" | "TELEGRAM_TARGET_CHAT not set"
}
```

### Exact JSON shapes (frontend mirrors these; Go emits snake_case)

`GET /healthz` → `model.Health`:

```json
{
  "ok": true,
  "version": "go-9ba53a6087b3d2c0",
  "uptime_secs": 1234,
  "queue": {
    "depth": 0,
    "capacity": 8,
    "workers": 4,
    "blocked": false,
    "in_flight": 0,
    "completed": 12,
    "failed": 0
  },
  "cloud": { "...": "Capabilities() as above" }
}
```

`GET /v1/vault/status` → `vault.Status` (`go/internal/vault/telegram.go`):

```json
{
  "configured": false,
  "authorised": false,
  "account": "…",
  "chat": "…",
  "connections": 3,
  "part_bytes": 2031616000,
  "session_path": "C:\\…",
  "detail": "…"
}
```

`POST /v1/vault/authorise` + `GET /v1/vault/authorise/{id}` →
`vault.LoginChallenge` (`go/internal/vault/login.go`):

```json
{
  "id": "…", "url": "tg://login?token=…", "expires_unix": 1760000000,
  "phase": "waiting" | "authorised" | "expired" | "password_needed" | "failed",
  "detail": "…", "rotations": 2, "account": "…"
}
```

Error mapping (`writeVaultError`): not-configured → 502/503, login in progress
→ 409, password needed → 422, revoked/not authorised → 401, ctx timeout → 504.

### QR-only login is a design decision — do not add phone login

`go/internal/vault/login.go` deliberately has **no phone-number flow**: Telegram
sends a login code the moment a code-based flow starts, and on a console-less
machine that code can only be wasted. The UI's Telegram modal therefore has no
phone option. If you ever add one, it must come with a console/agent that can
consume the code — otherwise leave it out.

### Probe helpers already written (unwired)

`go/internal/cloud/probe.go` exists in the working tree (gofmt + `go vet`
clean, unwritten tests): `Probe(ctx, key) → ProbeResult{OK, Detail}` on both
`GroqClient` and `GeminiClient` — GET the models list with the given key,
12 s timeout, **the key is never logged or echoed**. Review it, keep or rewrite,
then wire it per Task 1. Frontend must never call provider APIs directly (CORS +
key exposure); everything goes daemon → Rust → UI.

### Known bug to reconcile: two `.env` locations

- `src-tauri/src/env.rs` writes the app's `.env` into **app_data**.
- `ensure_daemon` (Rust, spawns `t9cloud`) reads/loads **exe-adjacent** `.env`.

Pick one source of truth (recommend app_data + explicit env injection into the
child process), fix both sides, and document the choice in the code comment.

### Rust side today

- No external HTTP client in `Cargo.toml` — loopback-only `http_get_json`
  exists. Provider key tests **must** go through the daemon, not from Rust.
- `daemon_health` command exists (`ipc.ts` mirrors it); no env/key commands are
  registered in `generate_handler!` yet.

---

## 2. Frontend contract (what the UI already codes against)

Single module: **`Clipchamp_Bunny/src/lib/cloud.ts`**. The UI agent ships it
with honest stub results; **you replace the bodies** (and only the bodies) with
real calls. Expected exports (snake→camel mapping happens inside this module):

```ts
export interface CloudHealth {
  ok: boolean;
  version: string;
  uptimeSecs: number;
  queue: {
    depth: number;
    capacity: number;
    workers: number;
    blocked: boolean;
    inFlight: number;
    completed: number;
    failed: number;
  };
  cloud: Record<string, string>; // Capabilities() — keys: transcribe,
  // autocorrect, analyze, vault, vault_upload
}
export function fetchHealth(): Promise<CloudHealth | null>; // null = daemon down

export interface ProbeResult {
  ok: boolean;
  detail: string;
} // detail: real daemon sentence, safe to show, never the key
export function probeGemini(key: string): Promise<ProbeResult>;
export function probeGroq(key: string): Promise<ProbeResult>;
// Both call the REAL endpoint now: POST /v1/keys/probe {"service":"gemini"|"groq","key":"…"}
// → 200 {"ok":bool,"detail":"…"}. Empty key = re-verify the daemon's own configured key.

export function saveApiKey(service: "gemini" | "groq", key: string): Promise<ProbeResult>;
// = persist securely (Task 2) + reload daemon capabilities (Task 5). STILL STUBBED — honest "unavailable".

export interface VaultStatus {
  configured: boolean;
  authorised: boolean;
  account?: string;
  chat?: string;
  connections: number;
  partBytes: number;
  sessionPath: string;
  detail?: string;
}
export function fetchVaultStatus(): Promise<VaultStatus | null>; // null = daemon down

export type LoginPhase = "waiting" | "authorised" | "expired" | "password_needed" | "failed";
export interface LoginChallenge {
  id: string;
  url?: string;
  expiresUnix?: number;
  phase: LoginPhase;
  detail?: string;
  rotations: number;
  account?: string;
}
export function beginTelegramLogin(): Promise<LoginChallenge>; // POST /v1/vault/authorise
export function pollTelegramLogin(id: string): Promise<LoginChallenge>; // GET /v1/vault/authorise/{id}
```

UI rules the backend must not break:

- A key field being non-empty is **never** shown as "Connected".
- The UI never displays a saved key in full (masked / last-4 only) — do not add
  an endpoint that returns the full stored key.
- Progress "n of 4" counts services actually **configured and verified**, so
  your `capabilities`/`status` answers drive it truthfully.
- Secrets never in logs, never in `localStorage`, never in source.

---

## 3. Tasks (priority order)

### Task 1 — Probe endpoints (highest priority)

- Wire `cloud.Probe` into `server.go`:
  - `POST /v1/cloud/probe/gemini` body `{"key": "…"}` → `{"ok": bool, "detail": string}`
  - `POST /v1/cloud/probe/groq` body `{"key": "…"}` → `{"ok": bool, "detail": string}`
- The probe hits the provider models list (already in `probe.go`); 401/403 →
  `ok:false` with a stable detail code the UI can translate (`invalid_key`,
  `network`, `rate_limited`, `ok`). Never echo the key anywhere, including
  error strings.
- Add `go test` with `httptest` + `io.Discard` server fakes for ok / 401 /
  timeout. No real network in tests.

### Task 2 — Persist API keys securely

- Decide and document: Windows **DPAPI** (`keyring` crate or `windows`
  credential APIs) in Rust, **or** the `.env` file with a restrictive ACL and a
  written limitation note. Prefer DPAPI for the two provider keys.
- Rust command `save_api_key(service, key)`: validate shape first
  (Gemini ≈ `AIza…` 39 chars; Groq ≈ `gsk_…`), persist, then trigger Task 5.
- Atomic write; no key in logs, no key returned to the frontend.

### Task 3 — Fix the `.env` location split

- One source of truth for the daemon's env: app_data `.env`, injected into the
  child process env at spawn (or exe-adjacent, but pick one). Update `env.rs`,
  `ensure_daemon`, and `config.readEnvFile` accordingly. Add a comment explaining
  the choice.

### Task 4 — Rust command surface (signatures only in `lib.rs`)

Register in `generate_handler!` (logic in a separate module, camelCase serde,
mirror in `src/lib/types.ts`):

| Command              | Calls                                 |
| -------------------- | ------------------------------------- |
| `cloud_probe_gemini` | daemon `POST /v1/cloud/probe/gemini`  |
| `cloud_probe_groq`   | daemon `POST /v1/cloud/probe/groq`    |
| `cloud_save_key`     | Task 2 + daemon reload                |
| `cloud_health`       | daemon `GET /healthz`                 |
| `vault_status`       | daemon `GET /v1/vault/status`         |
| `vault_login_begin`  | daemon `POST /v1/vault/authorise`     |
| `vault_login_poll`   | daemon `GET /v1/vault/authorise/{id}` |

Loopback fetch with timeout, treat daemon-down as `null`/typed error — the UI
already renders the offline state.

### Task 5 — Daemon reload after config change

After a key save, capabilities must flip to `ready` without the user restarting
anything: either a SIGHUP-style reload endpoint (`POST /v1/reload` re-reading
config) or `ensure_daemon` restart. Prefer a reload endpoint; restart loses
queue state.

### Task 6 — Telegram QR flow parity

- No new flow needed; ensure the modal's states map 1:1 to `LoginPhase`
  (`password_needed` → 422 handling already server-side).
- Session file stays on disk (`session_path`), never serialised to the frontend
  beyond the path. 2FA password comes from `TELEGRAM_2FA_PASSWORD` only.
- `TELEGRAM_TARGET_CHAT` needed for "vault_upload ready"; consider a small
  endpoint or reuse `.env` write from Task 2 for the T9 Cloud card's Configure.

### Task 7 — T9 Cloud card "Configure"

Decide the minimal surface: writing `TELEGRAM_TARGET_CHAT` (and future
`T9CLOUD_*` settings) through the same secure env-write path as Task 2, plus
health info already shown from `/healthz`. Keep it one endpoint if possible
(`POST /v1/cloud/config` with an allowlist of keys).

### Task 8 — Verification & shipping

```powershell
# Go
cd go; gofmt -l .; go vet ./...; go test ./...

# Rust (no release builds on this box!)
cd Clipchamp_Bunny; npm run check          # types.ts ↔ Rust shapes
T9_ALLOW_LOCAL_RUST= cargo check           # via src-tauri

# Ship (CI compiles the Rust release; ledger records it)
pwsh -File tools\deploy.ps1 -Ci -Agent "<you>" -Model "<provider/model>" `
     -Task "..." -Why "..." -Scope go      # or both
```

- A `go`/`both` work order must not be recorded `shipped` unless the installed
  daemon's version (Go source hash) matches what the order intended.
- Update `src/lib/cloud.ts` bodies to the real calls **in the same deploy** as
  the endpoints, so UI never points at 404s in a shipped build.

---

## 4. Out of scope / do not touch

- UI layout, copy, animations, i18n — UI agent's lane (`src/lib/components/…`).
- `public/assets/*`, `src/lib/mock.ts` — shared demo fixtures (AGENTS.md §8).
- Phone-number Telegram login (see §1 — deliberate omission).
- Any public server, any non-loopback bind, any Python.
