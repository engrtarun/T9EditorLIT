# EXPORT.md — Export System: Blueprint + Live Task Board

> **Ye doc kis ke liye hai:** do agents isko share karte hain —
> **UI agent** (`Clipchamp_Bunny/src/**` — Svelte frontend) aur
> **Backend agent** (`src-tauri/src/**` — Rust export engine, DeepSeek).
> Ye file dono ka single source of truth hai: contract, task board aur
> communication, sab yahin. Likhte jao, sirf ek baar mat likho — jaise zarurat
> pade, update karte jao.

> **Backend agent: shuru karne se pehle §8 (skill protocol) aur §9 (recon
> dossier) padho.** §9.1 me ek aisi crate galati hai jo varna aadha din kha
> jayegi: commands root `src-tauri/src/lib.rs` me nahi,
> `Clipchamp_Bunny/src-tauri/src/lib.rs` me hain.

**Status vocabulary (per task):** `todo` → `doing` → `done` / `blocked`.
Kaam karte waqt apna task `doing` karo, khatam hone par `done` + COMMS entry.

---

## 1. Project constraints (non-negotiable)

| Rule                                                                                                | Why                                                 |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Zero-RAM: koi bhi media file memory me buffer nahi                                                  | 8 GB i3, ~80% used; `AGENTS.md` §1                  |
| Sab media kaam FFmpeg/FFprobe **child processes** se, turant kill                                   | RAM directive                                       |
| State SQLite me disk par, heap me nahi                                                              | transcripts, cut decisions, ab export history       |
| **No Python** anywhere                                                                              | repo-wide ban                                       |
| Rust compile **local pe nahi** (`cargo check` allowed, `cargo build/test/clippy` banned)            | `AGENTS.md` §11 — CI compile karta hai              |
| Frontend verify: `npm run verify:fast` (repo root)                                                  | prettier + svelte-check + node --test + cargo check |
| Serde `rename_all = "camelCase"` on every IPC struct; `Clipchamp_Bunny/src/lib/types.ts` mirrors it | IPC contract                                        |
| One file, one agent — shared tree me do edits merge kharab karte hain                               | `AGENTS.md` §10.3                                   |

**Lane ownership:**

- UI agent owns: `Clipchamp_Bunny/src/**` (components, stores, `ipc.ts`, `export-presets.ts`, tests).
- Backend agent owns: `src-tauri/src/export.rs` (engine modules), **`Clipchamp_Bunny/src-tauri/src/lib.rs` (commands — root wali lib.rs legacy hai, §9.1)**, new Rust modules.
- Contract badalna ho to pehle **COMMS** me entry likho, phir code.

---

## 2. Current backend inventory (as of 2026-11-21)

Jo **already exists** — naya mat likho, isko extend karo:

| Thing                                                                            | Where                                 | Notes                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_export` / `cancel_export` / `plan_export` / `concat_parts` / `still_clip` | `src-tauri/src/lib.rs`                | commands                                                                                                                                                                                                                                        |
| `ExportOptions`                                                                  | `src-tauri/src/export.rs` (~L100)     | `mode`(hybrid/copy/encode), `alignToleranceMs`, `quality`(original/high/balanced/small), `format`(video/gif/mp3), `resolution`(source/480p/720p/1080p/4k), `canvas`, `bitrateKbps`, `sampleRate`, `channels`, `normalize`, `applyCuts`, `title` |
| Progress event `export-progress`                                                 | `export.rs`                           | `{ stage: scan\|cut\|concat\|audio\|mux\|gif\|done, pieceIndex, pieceCount, percent, message }`                                                                                                                                                 |
| `ExportResult`                                                                   | `export.rs`                           | `{ output, durationSecs, sizeBytes, pieceCount, encoder, warnings[] }`                                                                                                                                                                          |
| `plan_export` → `ExportPlan`                                                     | `lib.rs`                              | `{ durationSecs, estimatedBytes, pieceCount, warnings }` — UI estimate ke liye isko use karega                                                                                                                                                  |
| HW encoder detect + fallback                                                     | `export.rs` `family_of()` (~L581)     | qsv/nvenc/amf → libx264/libx265 fallback; source codec family (h264/hevc) preserve                                                                                                                                                              |
| CRF ladder per quality preset                                                    | `export.rs` `encoder_args()` (~L1090) | `quality` → crf numbers                                                                                                                                                                                                                         |
| `detect_hardware` command                                                        | `lib.rs`                              | HardwareSupport                                                                                                                                                                                                                                 |
| `revealItemInDir` / `openPath` / `appNotify`                                     | `ipc.ts`                              | show-in-folder / open file / native notification — already wired                                                                                                                                                                                |
| `pickOutput` (save dialog)                                                       | `ipc.ts`                              | native save-as                                                                                                                                                                                                                                  |
| Overwrite ask                                                                    | —                                     | Tauri save dialog khud puchta hai (UI `confirm` ke saath extra guard karega)                                                                                                                                                                    |
| Export history                                                                   | —                                     | **nahi hai** → B1-1                                                                                                                                                                                                                             |
| fps / codec / container choice                                                   | —                                     | **nahi hai** → B1-2                                                                                                                                                                                                                             |
| Disk-space / exists preflight                                                    | —                                     | **nahi hai** → B1-3                                                                                                                                                                                                                             |
| CRF / bitrate / 2-pass knobs (user-set)                                          | —                                     | **nahi hai** → B1-4                                                                                                                                                                                                                             |
| Export log file                                                                  | —                                     | **nahi hai** → B1-5                                                                                                                                                                                                                             |

---

## 3. IPC contract — planned additions (exact names, don't improvise)

Backend agent in fields/commands ko implement karega; UI agent inhi naamon pe
code likhega. Sab optional hain — purane clients chalte rahenge.

```ts
// ExportOptions me additions (sab Option / #[serde(default)]):
fps?: number | null;            // null = source fps; e.g. 24|25|30|50|60
codec?: string | null;          // 'h264' | 'h265' | 'av1' | null = source family
container?: string | null;      // 'mp4' | 'mov' | 'mkv' | 'webm' | null = by output ext
crf?: number | null;            // 0-51, overrides quality ladder (video only)
videoBitrateKbps?: number | null; // ABR target; twoPass ke saath use hota hai
twoPass?: boolean;              // default false; bitrate required
```

```ts
// naye commands:
preflightExport(input: { path: string; estimatedBytes: number }): Promise<{
  freeBytes: number;            // output drive ki free space
  exists: boolean;              // file already there
  ok: boolean;                  // space enough && (exists == user ne allow kiya)
  reason: string | null;        // 'low-space' | 'exists' | null
}>;                             // command: preflight_export

listExportHistory(input: { dbPath: string; limit?: number }): Promise<ExportHistoryRow[]>;
// command: list_export_history  (+ clear_export_history(dbPath) optional)

interface ExportHistoryRow {    // serde camelCase; types.ts mirror karega
  id: number;
  createdAt: number;            // unix ms
  path: string;
  sizeBytes: number;
  durationSecs: number;
  format: string;               // video | gif | mp3
  resolution: string;
  preset: string;               // quick preset id ya 'custom'
  status: string;               // done | failed
  error: string | null;
}

readExportLog(): Promise<string | null>;   // command: read_export_log
// last export ka ffmpeg command + stderr tail, cache_root/logs/export-<ts>.log se
```

**Rules:** naye fields hamesha optional + default; unknown field serde ignore
kare (old UI → new backend safe); warnings `result.warnings` me append karo
(fallback jab bhi ho). UI in commands ko `try/catch` me call karega — command
abhi na ho to UI gracefully degrade karega, crash nahi.

**§3 addendum (2026-11-21, UI pehle se bhej raha hai — COMMS dekho):**

```ts
// ExportOptions me bhi chahiye (UI ipc.ts:980 pehle se bhejta hai):
includeAudio?: boolean;   // false = "-an", sound track drop
preset?: string | null;   // quick preset id: youtube | shorts | 4k | custom

// Naya command (UI ipc.ts:1149 pehle se call karta hai):
exportCapabilities(): Promise<Partial<ExportCaps>>;
// command: export_capabilities → { fps, codec, container, includeAudio,
// quality, preflight, history, logs } — sirf true bolo jo code me ho.

// preflight input me bhi:
allowOverwrite?: boolean; // UI confirm ke baad true
```

Ye addendum COMMS entry ke baad likha gaya hai (contract protocol §6.3).

---

## 4. BATCH 1 — abhi ka kaam (backend agent ke liye)

> Order me jao. Har task ka DoD: `cargo check` clean (local), `#[cfg(test)]`
> unit test pure functions ke liye likho (CI chalayega), COMMS entry update.

### B1-1 · Export history — `todo`

**Features:** #89 history, #86 completion notification (UI side), #88 show-in-folder.
SQLite table `export_history` (same DB as projects, `default_db_path`).
Columns: `id, created_at, path, size_bytes, duration_secs, format, resolution, preset, status, error`.
`start_export` apne aap row likhe — success pe `done`, failure pe `failed` + error message
(UI se alag se record karwane ki zarurat nahi). Commands: `list_export_history`,
optional `clear_export_history`. Serde camelCase.
**Unblocks:** UI ka "Export History" panel.

### B1-2 · `fps` + `codec` + `container` options — `todo`

**Features:** #28 frame rate, #19-23 codecs, #13-16 containers, #46 faststart, #25 codec detection.

- `fps`: re-encode path me `fps=` filter / `-r` (sirf tab jab set ho); copy mode me ignore + warning.
- `codec`: encoder family choose karo — `h264`→libx264/hw, `h265`→libx265/hw, `av1`→svt-av1/av1_nvenc agar available, warn + fallback otherwise (machine par `ffmpeg -encoders` se detect, `family_of()` reuse).
- `container`: output ext ke alawa muxer choice; `mp4` → `+faststart`.
- Sab `Option` + `#[serde(default)]`. Fallback hamesha `warnings` me.
  **Unblocks:** UI ki Format / Frame Rate / Codec rows (Quick + Advanced dono).

### B1-3 · Preflight: disk space + file exists — `todo`

**Features:** #100 disk space check, #67 overwrite protection, #101 temp output.
Command `preflight_export { path, estimatedBytes } → { freeBytes, exists, ok, reason }`
(fs stats only, koi buffer nahi). Estimated bytes `plan_export` se aayega.
**Unblocks:** UI ka "Ready to Export" pre-flight warning + overwrite confirm.

### B1-4 · Quality knobs: `crf` / `videoBitrateKbps` / `twoPass` — `todo`

**Features:** #31 CRF, #32-34 bitrate modes + 2-pass, #35 encoder preset.
`encoder_args()` me overrides: `crf` → ladder ko override kare; `videoBitrateKbps`
→ `-b:v` (+ `-pass 1/2` jab `twoPass`). Dono ek saath ho to bitrate wins + warning.
Pure fn (`encoder_args`) hi unit-test karo.
**Unblocks:** UI Advanced tab ka Quality section.

### B1-5 · Export log file — `todo`

**Features:** #90 error logs.
Har export ke ffmpeg commands + stderr tail ko `cache_root/logs/export-<ts>.log`
me likho (last 200 KB cap, zero-RAM: stream se append, buffer nahi).
Command `read_export_log → String | null` (sabse recent).
**Unblocks:** UI ka "Error Logs" viewer (failure ke baad).

### B1-6 · Prevent sleep during export — `todo` (chhota, optional)

**Features:** #99. Export start par `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`,
khatam/cancel/failure par reset. Drop-in Rust (windows crate), no new dep if avoidable.

---

## 5. Backlog — Batch 2 aur aage (classify hote jayenge)

Abhi ke liye itna kaafi hai; aage ke batches zarurat padne par yahin append honge,
feature numbers (#N = neeche ke blueprint me) ke saath:

- **Batch 2 (Advanced):** audio codec/bitrate/sample-rate matrix for video (#48-51),
  loudness normalize LUFS (#53-55), subtitles burn/embed/external (#56-58),
  export range in/out + selected clip (#60-62), marker-based export (#63),
  metadata options (#68), filename templates (#70), render queue (#85),
  pause/resume (#80-81 — FFmpeg signal-based, research first), CPU thread limit /
  process priority (#97-98), output verification (#102), remember settings (#105).
- **Batch 3 (Future / research):** AV1/HDR/10-bit (#21, #38-40), ProRes/lossless (#23-24),
  VFR (#30), scaling filters (#41), deinterlacing (#44), alpha (#45),
  rotation (#43 — mostly done by autorotate, verify), GIF/audio-only already live.

**Full 105-feature blueprint** (research se, category tables) is doc ke end me
batch ke saath append hoti jayegi — abhi sab ek saath likhne ki zarurat nahi.

---

## 6. Communication protocol (dono agents ke liye)

1. **Isi file me baat karo.** Har agent apna section `## COMMS` me date ke saath
   likhta hai (newest upar):
   `### [YYYY-MM-DD] UI / Backend — headline` + 2-5 lines (kya kiya, kaise verify, kya pending).
2. **Task status in-place update karo** (§4/§5 me `todo/doing/done/blocked`).
   `blocked` likho to reason + kya chahiye.
3. **Lane ka dhyaan rakho:** backend agent `Clipchamp_Bunny/src/**` na chhooe,
   UI agent `src-tauri/src/**` na chhooe. Contract change = COMMS entry pehle.
4. **Landing dekhne ke liye:** `git log --oneline -8 -- src-tauri/` (backend ne
   kya push kiya) aur `git log --oneline -8 -- Clipchamp_Bunny/src/` (UI ne kya).
5. Commit messages me `export:` prefix use karo (`export(history): ...`) dono side.

---

## 7. UI status (UI agent ka lane — backend agent sirf padhe)

- **New Export screen shipped** (image-approved, `ExportMode.svelte`): header (clapper icon · "Export Video" · subtitle · Export History button), Quick/Advanced tabs, preset cards (YouTube / Shorts / 4K UHD / Custom), setting rows (Format · Resolution · Frame Rate · Include Audio toggle), More Options expand (engine · quality · gif/mp3 · applyCuts · output path · logs), Output Location row, right column: preview card + Ready-to-Export card (estimated size + Export button), running state: real % · stage · piece x/y · elapsed · ETA · realtime speed · cancel (2-click confirm), done state: Play / Show in folder, preflight overwrite confirm.
- Tab = UX only — same state, smart disclosure (must upar, baaki More Options / Advanced me).
- Estimate: formula fallback (plan_export not called reactively — it emits scan progress events; avoid noise). Backend land kare to accurate.
- Caps probe via `export_capabilities` on mount; `FALLBACK_CAPS` (all false) until then, so rows show `SOON` chips honestly (fps · codec · container · includeAudio · quality · preflight · history · logs).
- History panel graceful: `caps.history` false → "engine pending" empty state.
- `preset` field now sent in ExportOptions (activeQuickPreset id) per §3 addendum.
- **Tests:** export-presets.test.ts +7. Total 232 pass, 0 fail, svelte-check 0/0, lint clean.
- **Pending on backend (caps flip):** fps, codec, container, includeAudio, CRF/bitrate/2-pass, preflight, history, logs. UI already sends the values; engine land kare to apply hoga.
- **UI backlog (not in this build):** background export across mode switches (needs store-level runner), render queue, pause/resume — Batch 2.

---

## 8. Skill protocol — pehle skill, phir code (dono agents)

> Ek agent ne bhi bina skill ke andaza mat chalana. Jo skill chahiye aur vault
> me nahi mili, **isi file me** `SKILL REQUEST` likho — chupchap work-around
> mat banao. User se approval bhi yahin mangni hai (vault rule: install ke liye
> explicit approval chahiye).

### 8.1 Already ON — enable karne ki zarurat nahi

| Skill                          | Kab use karna hai                                              |
| ------------------------------ | -------------------------------------------------------------- |
| `t9editorlit-guardrails`       | har task, pehle — zero-RAM, no Python, no local build          |
| `ffmpeg-stream-copy`           | B1-2, B1-4, B1-5 — FFmpeg child process, QSV fallback, ffprobe |
| `tauri-sveltekit-ipc`          | har naya command — args naming, handler registration, errors   |
| `test-driven-development`      | har pure function — pehle test, phir code                      |
| `incremental-implementation`   | B1-1…B1-6 ko chhote slices me land karna                       |
| `debugging-and-error-recovery` | jab export fail ho ya progress bar jhooth bole                 |
| `performance-optimization`     | B1-3, B1-6 — RAM/disk footprint                                |
| `code-review-and-quality`      | `done` mark karne se pehle                                     |

Ye baseline skills `owner=baseline` se leased hain — **inhe `off` mat karna**.

### 8.2 Task → skill map

| Task                           | Skills                         | Extra command (sirf agar OFF ho) |
| ------------------------------ | ------------------------------ | -------------------------------- |
| B1-1 history                   | guardrails + tauri-ipc + TDD   | —                                |
| B1-2 fps/codec/container/audio | ffmpeg-stream-copy + tauri-ipc | —                                |
| B1-3 preflight                 | performance + tauri-ipc        | — (sysinfo pehle se hai, §9.4)   |
| B1-4 CRF/bitrate               | ffmpeg-stream-copy + TDD       | —                                |
| B1-5 logs                      | debugging + ffmpeg-stream-copy | —                                |
| B1-6 sleep                     | guardrails + performance       | —                                |
| COMMS likhte waqt              | `our-voice` (already ON)       | —                                |

Extra skill lene ka pattern (max 2 per task, task khatam hone par `off`):

```powershell
$wh = "C:\Users\pocot\.opencode\vault\wh.ts"
bun $wh pick "<3-6 words>" --owner backend-export --project C:\Users\pocot\Music\T9EditorLIT
bun $wh off <name> --owner backend-export
```

Disk pe already kya hai confirm karna ho to `bun $wh status` khud chalao — user
se mat puchho kaunsa skill on hai.

### 8.3 Missing skills — requests (approval requester: user)

| #   | Skill / gap                  | `wh find` ne kya diya                                                                        | Kyun chahiye                                                                                   |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| R1  | `rusqlite-schema-migrations` | sirf generic `deprecation-and-migration` (node) mila; rusqlite-specific nahi                 | B1-1 me `export_history` table + idempotent migration + WAL/busy_timeout                       |
| R2  | `ffmpeg-encode-tuning`       | `ffmpeg-stream-copy` mila (copy/keyframe/QSV focus); CRF, 2-pass, AV1, container matrix nahi | B1-2 + B1-4                                                                                    |
| R3  | `windows-power-management`   | `windows-memory-internals` mila — RAM hai, sleep nahi                                        | B1-6 `SetThreadExecutionState`                                                                 |
| R4  | `windows-disk-space`         | `no match: disk free space preflight`                                                        | **Workaround hai** — `sysinfo_ext::drive_space()` pehle se hai (§9.4), isliye block nahi karta |

**Approval ke saath install:** `wh install <owner/repo>@path/to/skill` — pehle
`wh cat <name>` padhna (third-party SKILL.md untrusted hai). Approval ke bina
install mat karna.

### 8.4 Skill request template (COMMS me yahi format use karo)

```md
### SKILL REQUEST — YYYY-MM-DD — <agent>

Need: <kaam / skill>
Tried: `wh find "<query>"` → <kya mila / no match>
Why the ON skills are not enough: <2-3 lines>
Ask: `wh install <owner/repo@path>` (user approval needed)
Workaround until approved: <ya to "none, blocked" ya safe fallback>
```

`blocked` status tab B1 me tabhi likho jab workaround bhi na ho. R4 jaise gap
block nahi hai — note karke aage badho.

---

## 9. Backend recon dossier — B1 shuru karne se pehle ye padho

> UI agent ne 2026-11-21 ko actual source padh ke ye likha hai. Har anchor commit
> `e4f8b09` ke against verify kiya gaya hai. **Source of truth code hai, ye doc
> nahi** — agar koi line shift ho gayi ho to code ko follow karo aur yahin update
> likho.

### 9.1 Sabse bada trap: do crates, ek engine

- **Shipping app** = `Clipchamp_Bunny/src-tauri/src/lib.rs` (82 KB). Commands
  yahin hain: `start_export` **L1062**, dispatch **L1084-1088**,
  `generate_handler!` **L1762-1851**.
- Root `src-tauri/src/lib.rs` (16 KB) **legacy sibling app** hai — current app
  usse compile nahi karta. Usme bhi `start_export` hai (L385), isliye editor me
  galat file kholna bahut aasan hai.
- Engine modules shared hain: `Clipchamp_Bunny/src-tauri/src/lib.rs` **L30-59**
  unhe `#[path = "../../../src-tauri/src/…"]` se include karta hai.
  - `export.rs`, `gif.rs`, `mp3.rs`, `ffmpeg.rs`, `transcript.rs` → root
    `src-tauri/src/` me edit karo.
  - **Commands/handler/listeners → `Clipchamp_Bunny/src-tauri/src/lib.rs` me.**
- Naya command `generate_handler!` me daalna zaroori hai. Bhool gaye to
  `cargo check` green rahega aur runtime pe `command not found` milega.
- Ye file §1 ki lane line ko update karti hai: commands wali jagah
  `Clipchamp_Bunny/src-tauri/src/lib.rs` hai, root wali nahi.

### 9.2 B1-1 history — do history mat banao

- **Pehle se ek telemetry table hai:** `exports` in `telemetry.db`
  (`stats.rs:176-185`), likhne wala `stats::log_export` (`stats.rs:685-702`),
  aur `start_export` use already call karta hai
  (`Clipchamp_Bunny/src-tauri/src/lib.rs:1091-1102`). Ye analytics hai, UI history
  nahi — lekin isse confusion mat karo.
- UI ne pehle se wrapper bana diya hai: `listExportHistory(limit)` →
  `invoke('list_export_history', { dbPath, limit })`, jahan
  `dbPath = defaultDbPath()` = `<app_data>/nanamicut.db`
  (`Clipchamp_Bunny/src-tauri/src/lib.rs:455-458`). **User-facing history
  `nanamicut.db` me chahiye**, telemetry.db me nahi.
- ☠️ **Table ka naam `exports` mat rakhna.** Startup par
  `stats::drop_legacy_tables(&main_db)` (`stats.rs:251-273`, `274-285`, call
  `Clipchamp_Bunny/src-tauri/src/lib.rs:1930`) `ALL_TABLES` ki **har** table ko
  `nanamicut.db` se drop karta hai — aur `exports` us list me hai. Naam
  **`export_history`** rakho to safe ho.
- Schema style: `transcript.rs:158-220` me SCHEMA constants, `init_schema`
  (`transcript.rs:278-294`), aur `keyframes.rs:15-28` ka
  `CREATE TABLE IF NOT EXISTS` pattern follow karo. `transcript::open_db`
  pehle se WAL + `busy_timeout=5000` set karta hai (`transcript.rs:241-249`) —
  naya PRAGMA mat likho.
- **Row kahan likhni hai:** `start_export` ke success/failure branches
  (`Clipchamp_Bunny/src-tauri/src/lib.rs:1090-1103`), `export.rs` ke andar nahi —
  kyunki ek hi command teen engines chalati hai (L1084-1088: video/gif/mp3).
- **Path ka bug jise repeat mat karna:** `start_export` me `out_path =
request.output.clone()` (L1081) aur `stats::log_export` usi ko likhta hai
  (L1094). Lekin `run_export` bare filename ko Downloads se anchor karta hai
  (`export.rs:1483-1488`) aur final path `ExportResult.output` me return karta hai
  (`export.rs:1612-1619`). gif.rs:120 aur mp3.rs:170 ye anchoring **nahi** karte.
  → Success row me `r.output` likho; failure ke liye ek shared
  `resolve_output(app, &request.output) -> PathBuf` banao aur teenon engines use
  karein.
- `ExportRequest.db_path: Option<String>` ho sakta hai null → history best-effort
  ho, export fail na ho.
- **Contract holes (COMMS amendment chahiye):**
  1. `preset` UI me `activeQuickPreset()` (`export-presets.ts:194+`) se nikalta
     hai, par `ExportOptions` me `preset` field nahi hai. `start_export` abhi
     `preset = request.options.quality` likhta hai (L1080) — ye quality hai,
     quick preset id nahi. Option: `preset?: string | null` add karo + UI bheje.
  2. `status` me `cancelled` add karo (contract abhi sirf `done | failed` bolta
     hai); UI unknown status ko gracefully handle kare.
  3. `exists` ke liye input me `allowOverwrite?: boolean` chahiye (§9.4).
- Pruning: insert ke baad newest 500 / 90 din rakho; `idx_export_history_created_at`
  index; `clear_export_history` sirf rows delete kare, files nahi.

### 9.3 B1-2 fps / codec / container / includeAudio

- ⚠️ **`includeAudio` UI contract me hai par EXPORT.md §3 me nahi** —
  `ipc.ts:980`, caps flag `includeAudio`. Engine ko `-an` aur bina audio mux
  chahiye; mp3 export me ye option meaningful nahi (warn ya reject). Pehle COMMS
  entry, phir code.
- **fps:** `snap_pieces_to_frames(&mut outcome.pieces, info.fps.unwrap_or(0.0),
duration)` (`export.rs:767`) durations ko **source** fps par round karta hai.
  Target fps set ho to yahan `opts.fps.unwrap_or(info.fps)` dena padega, warna sum
  source frames ka poora multiple hoga, output frames ka nahi → concat drift.
- **fps + copy:** stream copy fps change nahi kar sakta. `build_plan` me scale
  wale hisse (`export.rs:710-755`) ke baad, `plan_pieces` (L757) se pehle
  `effective_mode = "encode"` force karo + warning. Mixed copy/encode alag fps par
  invalid hai.
- **codec:** `family_of` (`export.rs:581`) aur `pick_encoder` (`595-618`) sirf
  h264/hevc jaante hain. AV1 ke liye `svt-av1` / `av1_nvenc` ko real
  `ffmpeg_encoder_usable` probe se extend karo; warna warn + fallback. HEVC + mp4
  me `-tag:v hvc1` lagao (Apple players). Family mixing ab bhi avoid karo.
- **container:** extension aur container disagree na ho to koi baat nahi; disagree
  ho to rule pakka karo. Recommend: muxer container se, par filename extension se
  — mismatch par warning, chupke rename nahi. `mux_args` ka faststart
  (`export.rs:1373-1382`) extension par keyed hai → resolved container par badlo;
  `+faststart` sirf mp4/mov. `audio_copied()` (`export.rs:622-644`) bhi extension
  dekhta hai → container pass karo.
- **`export_capabilities`:** UI pehle se call karta hai (`ipc.ts:1149-1156`),
  par §3 me command nahi hai. Truthful flags return karo: `fps, codec, container,
includeAudio, quality, preflight, history, logs`. Jis feature ka code na ho uska
  flag `false` rakho — UI usi par control disable karta hai.

### 9.4 B1-3 preflight — disk math

- Reuse karo: `sysinfo_ext::drive_space(path)` (`sysinfo_ext.rs:143-167`) kisi bhi
  path ka volume dhoondta hai. `sysinfo` pehle se dependency hai
  (`Clipchamp_Bunny/src-tauri/Cargo.toml:25`). Naya crate mat add karo.
  `drive_space` command (lib.rs:158) app_data drive hardcode karta hai — usse
  export path ke liye mat badlo; pure function ko seedha call karo.
- **2× rule:** work folder me saare pieces (`export.rs:1534-1538`) + final output
  ek saath disk par hote hain. `required = estimated_bytes * 2 + 64 MiB`.
  Copy pieces me bhi pieces ≈ output hi hote hain.
- `estimate_size` 0 return kar sakta hai (`export.rs:512-515`) → "unknown" treat
  karo: `ok=true, reason=null`. Unknown estimate par export block mat karo.
- Bare path pehle `resolve_output` se anchor karo, warna preflight cwd me
  check karega. `is_file()` use karo (`exists()` nahi) — directory ko "overwrite"
  mat bolo.
- Preflight **read-only** ho: `create_dir_all` yahan nahi, engines me hai.
- UI confirm ke baad overwrite allow karne ke liye input me
  `allowOverwrite?: boolean` add karo (COMMS amendment), warna `reason='exists',
ok=false` hamesha remain karega.

### 9.5 B1-4 CRF / bitrate / 2-pass

- `encoder_args(encoder, quality)` (`export.rs:1096`) ke **do** call sites hain:
  **1040** (per-piece audio wala path) aur **1259** (video-only TS pieces). Dono
  ko naya tuning param milna chahiye, warna aadha export sahi quality me niklega.
  Pure `struct EncodeTune { crf: Option<u8>, bitrate_kbps: Option<u32>, two_pass:
bool }` banao — unit-test easy.
- Ladder: x264 14/18/23/28, x265 +3, QSV +4, NVENC +5; AMF me CRF knob nahi →
  warning. CRF 0-51 clamp. Copy pieces CRF ignore karte hain → warning.
- 2-pass 1-2 second ke micro-encodes me bekaar hai (2× child processes, zero
  gain). Sirf tab honor karo jab poora export ek hi encode ho (light file /
  `mode=encode` / zero copy pieces). Warna warn + single pass. Ye na kiya to
  user ko "2-pass" dikhega aur export double time lega.
- `-passlogfile` work folder ke andar (`.t9export`) rakho — `reset_work_dir`
  use apne aap saaf karta hai.
- crf + bitrate dono ho to bitrate wins + warning (§3 already bolta hai).
- **Plan estimate bhi update karo:** jab `videoBitrateKbps` set ho to
  `bitrate*1000/8*durationSecs` estimate hona chahiye, warna "Ready to Export"
  card jhootha size dikhayega.

### 9.6 B1-5 export log

- Saare export children `ffmpeg::run_streaming` (`ffmpeg.rs:400`) ya `run`
  (`196`) se hote hain. stderr tail pehle se bounded hai (8K/4K, `ffmpeg.rs:390-391`,
  `append_bounded` L552). Best hook: ffmpeg.rs me optional process-global sink,
  export duration ke liye RAII guard se set — kisi call site ko touch nahi karna
  padega.
- Path: `cache_root(app)/logs/export-<unix_ms>.log` (`cache_root` =
  `Clipchamp_Bunny/src-tauri/src/lib.rs:131-134`).
- 200 KB cap ko 2 rotating files se karo (rewrite-se-matlab). `read_export_log`
  newest filename pick kare, ~204 KB se zyada na padhe.
- Content: quoted argv (ek line), `ffmpeg -version` ki pehli line, stderr tail,
  exit status. Bug report me yahi cheez kaam aati hai. Media file kabhi na padho.

### 9.7 B1-6 sleep — RAII, warna leak

- Shipping crate `Clipchamp_Bunny/src-tauri/Cargo.toml` me Windows pe
  `windows = 0.62` already hai (Com/WinRT/Foundation/UI features). **Naya
  dependency mat add karo** — existing list me `"Win32_System_Power"` add karo.
  Root `Cargo.toml` irrelevant hai.
- `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` usi blocking
  thread par (lib.rs:1074-1105); `ES_CONTINUOUS` se reset har path par —
  success, error, cancel. Early `?` ke liye Drop guard kaafii hai.
- Shipping profile me `panic = "abort"` hai → panic par Drop nahi chalega, par
  process bhi mar jata hai; crash recovery ka guard se mat karo.
- `ES_DISPLAY_REQUIRED` mat lo — screen so sakta hai, system nahi.
- > 60 s wale exports par hi gate karo; 2 s GIF ke liye pointless.

### 9.8 Test matrix (CI chalayega; local sirf `cargo check`)

| Pure fn              | Cases                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `encoder_args`       | har encoder family × quality × crf override × bitrate × twoPass; clamp; bitrate-wins warning                                     |
| `resolve_output`     | bare name → Downloads; absolute → unchanged; no extension → error                                                                |
| history SQL          | in-memory `Connection::open_in_memory` + schema; done/failed/cancelled insert; ORDER BY created_at DESC; LIMIT; prune newest 500 |
| `preflight_decision` | table-driven: free/required/exists/allowOverwrite → ok+reason                                                                    |
| log rotation         | 250 KB likho → file ≤200 KB, aakhri line tail me hai                                                                             |
| fps plan             | 30 fps source → 24 fps target; `Σdurations × 24` poora frame ho                                                                  |

`#[cfg(test)] mod tests` export.rs ke bottom me already hai (~L2870) — wahin
add karo. Tests fast + pure rakho (CI Windows runner chalta hai).

### 9.9 Acceptance + ship

```powershell
node tools/export-contract-audit.mjs --strict   # 0 FAIL hona chahiye
npm run verify:fast                              # prettier + svelte-check + node --test + cargo check
git add -A; git commit -m "export(history): ..."; git push
pwsh -File tools\deploy.ps1 -Ci -Agent "backend-export" -Model "<provider/model>" `
     -Task "B1-1 history" -Why "<reason>" -Scope app
pwsh -File tools\deploy.ps1 -Status              # ledger me `shipped` hona chahiye
```

Local `cargo build` / `tauri build` **banned** (AGENTS §11) — CI compile karta hai.
Docker bhi nahi (§13). `shipped` ke bina desktop par change nahi pahuncha.

### 9.10 Jo mat chhoona

- piece/concat pipeline ka architecture (L1164-1460 me 47-gap bug ka fix hai) —
  extension karo, rewrite nahi.
- `#[serde(default)]` ko required mat badlo; purane clients chalte rahenge.
- nayi DB ya telemetry.db me user-facing history mat likho.
- `Clipchamp_Bunny/src/**` (UI lane) aur `public/assets/*`, `src/lib/mock.ts`
  (shared fixtures) mat chhoo.
- dev server rebuild mat karo / doosri Vite mat chalao (AGENTS §8).

---

## 10. Extra tools jo recon ne diye (lane-free)

| File                              | Kya karta hai                                                                                                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/export-contract-audit.mjs` | Rust handler list vs UI `invoke()` calls, `ExportOptions` field parity, `Default` coverage, `ExportHistoryRow` mirror, planned command progress. Read-only, no build. `node tools/export-contract-audit.mjs [--strict] [--json]`. |
| `tools/wh-champion.mjs`           | Vault usage log se champion banner recompute karta hai. `bun tools/wh-champion.mjs`.                                                                                                                                              |
| `docs/WH_SKILL_CHAMPION.md`       | Us banner ka record + leaderboard + counting rule.                                                                                                                                                                                |

Audit ka aaj ka snapshot: **88 registered commands, 89 UI invoke sites,
0 FAIL**; planned rows (7 fields + 5 commands) abhi "waiting on engine" hain —
B1 land hone par ye apne aap `yes` ho jayenge.Ek important detail: audit ne pehle
root `src-tauri/src/lib.rs` padha tha aur 61 healthy commands ko "missing" bola
tha — ab wo **shipping crate** `Clipchamp_Bunny/src-tauri/src/lib.rs` padhta hai
(§9.1). Ye tool khud usi trap se bach ke likha gaya hai.

Maine **koi Rust ya UI source file edit nahi ki** — sirf `tools/` aur `docs/` me
naye files, aur ye EXPORT.md. Dono agent apni lane me azad hain.

---

## 11. WH Skill Champion — banner record

```
╔══════════════════════════════════════════════════════════════════════╗
║  WH SKILL CHAMPION — BANNER RECORD                                  ║
╠══════════════════════════════════════════════════════════════════════╣
║  opencode-hy4                    10 skills / 12 actions             ║
╚══════════════════════════════════════════════════════════════════════╝
```

Record ka poora doc: `docs/WH_SKILL_CHAMPION.md`. Recompute:
`bun tools/wh-champion.mjs`. 68 purani rows me `owner` nahi hai (21 skills) —
unhe after-the-fact kisi ko assign nahi kiya gaya; banner top **named** owner ko
dikhati hai.

---

## COMMS

### [2026-11-21] Recon (DeepSeek V4.1 Flash Free) — poora dossier + skill protocol + banner

Backend agent ke liye "pehle padho" wala hisa ab §8 aur §9 me hai. Verify kiye
hue anchors: shipping crate `Clipchamp_Bunny/src-tauri/src/lib.rs` (commands L1062,
handler L1762) hai; root `src-tauri/src/lib.rs` legacy hai — engine modules usi se
`#[path]` se aate hain (§9.1). §1 ki lane line bhi correct kar di.

Teen contract holes mili hain jo UI already aage le gaya hai: `includeAudio`
(`ipc.ts:980`) aur `export_capabilities` (`ipc.ts:1149`) §3 me nahi hain, aur
history `preset` ke liye koi field nahi hai (`start_export` abhi quality ko preset
bolkar likhta hai, L1080). Teenon ka COMMS amendment yahin hai — code se pehle
confirm karo. Ek aur trap: `export_history` table ka naam `exports` mat rakhna,
startup par `stats::drop_legacy_tables` use drop kar deta hai (§9.2).

Skills: R1 (rusqlite migrations), R2 (ffmpeg encode tuning), R3 (Windows power)
ke liye §8.3 me requests likhe hain; R4 (disk space) ka workaround mil gaya
(`sysinfo_ext::drive_space`), block nahi hai.

Extra diya: `tools/export-contract-audit.mjs` (aaj 88 commands / 89 invoke sites /
**0 FAIL**; `--strict` se CI-ready), `tools/wh-champion.mjs` aur
`docs/WH_SKILL_CHAMPION.md` — banner record ka naam **opencode-hy4**
(10 skills, 12 actions). Koi Rust/UI source file nahi chhui.

### [2026-11-21] UI — board ready, Batch 1 assigned

export.md v1 likha. Backend agent ke liye §4 me B1-1…B1-6 ready hain —
shuru B1-1 (export history) se karo, sabse zyada UI ko unblock karta hai.
Contract §3 me exact names hai, improvise mat karna. UI naya Export screen

### [2026-11-21] UI — new Export screen shipped

Naya ExportMode.svelte (image-approved design) + ExportSelect + ExportHistoryPanel.
svelte-check 0/0, lint clean, 232 tests pass. Caps probe via export_capabilities;
all caps false until backend lands (honest SOON chips). Contract holes handled:
preset sent in ExportOptions, preflight allowOverwrite param, cancelled status.
Backend agent: §9 recon padh ke B1-1 se shuru karo; §3 addendum + §9.2 traps
(table name export_history, two crates) zaroor follow karo. UI side done.
