# MEMORY — T9 Editor LIT (Nanami Cut)

> New session ke liye poora context. Is file ko pehle padhna.
> Requirement freeze: [`SPEC.md`](SPEC.md). UI vs Clipchamp: [`compare-vs-clipchamp.png`](compare-vs-clipchamp.png).

---

## 1. Ye app kya hai

**T9 Editor LIT** — lambi Hinglish coding tutorials (2 ghante / 5 GB / 1080p-4K 60 FPS) ke liye
**transcript-first video cutter**. Sirf do kaam:

1. **Faltu silence (dead air) hatana** — auto-detect + cut.
2. **Transcript padh ke video edit karna** — fumble / retake / galat-example lines ko
   ek-ek karke ✕ karke hatana, keyboard se.

Target machine: **Windows 11 · Intel i3 · 8 GB RAM (jismein ~80% pehle se busy)**.
Isliye **zero-RAM footprint** ek architectural constraint hai, optimisation nahi.

**Creator:** `@EngrTarunDilwal` · **Style:** Apna College / Coder Army.

---

## 2. Tech stack (LOCKED — isme se koi badalna nahi)

| Layer | Technology | Rule |
|---|---|---|
| Desktop shell | **Tauri v2** | WebView2 reuse, no Electron |
| UI | **Svelte 5** (runes) + **TypeScript** | no React, no heavy component libs |
| Styling | **Tailwind CSS 4** (`@theme` tokens) | v3 nahi |
| Core | **Rust** (Tauri commands) | pure logic in testable modules |
| Media | **FFmpeg / FFprobe child processes** | kabhi in-RAM decode nahi |
| Local state | **SQLite on disk** | transcript + cut decisions + undo |
| Cloud AI | **Groq** (Whisper Large v3) + **Gemini** (fumble flags) | Go `t9cloud` on 127.0.0.1:7878 |
| Cloud storage | **Telegram MTProto** (Go `go/internal/vault`) | QR auth, 1.9 GB split, 3–4 sockets |

### BANNED — poore repo me
**Python** (no pip/venv) · Electron · Qt · C++ · React · Tailwind v3 · in-memory frame decoding.

---

## 3. Folder map — kaha kya hai

```
C:\Users\pocot\Music\T9EditorLIT\
├── Clipchamp_Bunny\            ← ★ ASLI APP (canonical). Yahi build hota hai.
│   ├── docs\SPEC.md            ← requirement freeze (26 sections)
│   ├── docs\MEMORY.md          ← ye file
│   ├── docs\compare-vs-clipchamp.png
│   ├── src\lib\
│   │   ├── ipc.ts              ← ★ sirf jagah Rust se baat
│   │   ├── pipeline.ts         ← ★ t9cloud orchestration (transcribe→correct→analyze)
│   │   ├── segments.ts         ← pure edit-timeline maths (+ segments.test.ts)
│   │   ├── shortcuts.ts        ← Clipchamp shortcut registry
│   │   ├── types.ts            ← TS ↔ Rust shape mirror
│   │   ├── dashboard.ts        ← pure dashboard helpers (sort · "3 hours ago" · sizes)
│   │   ├── mock.ts             ← fallback transcript (scaled)
│   │   ├── media.ts            ← baked-asset loader (browser mode)
│   │   ├── stores\             project · player · mode · layout · media · cloud · toast · menu · keys · app
│   │   └── components\         TopBar · PreviewBar · ModeRail · RightRail · CloudMenu
│   │                            SystemMeter · ContextMenu · MenuIcon · ShortcutsHelp · Toasts
│   │                            dashboard\{HomeDashboard,DashboardTopBar,ProjectCard,BrandMark}
│   │                            cut\{VideoPreview,TranscriptPanel,WaveTimeline}
│   │                            media\{MediaPanel,MediaTile}
│   │                            modes\{IngestMode,CutMode,ExportMode}
│   ├── src-tauri\              ← Tauri shell; engine root se #[path] se share hota hai
│   ├── public\assets\          ← baked demo media (waveform.json, thumbs/, media.json)
│   ├── tools\generate-media.mjs ← demo media baker (real FFmpeg commands)
│   └── tools\deploy.ps1        ← ★ build → install → taskbar pin (one click update)
│       tools\pin-taskbar.ps1   ← ★ taskbar pin ka pura logic
├── src-tauri\src\              ← ★ SHARED Rust engine (transcript.rs, export.rs, waveform.rs…)
├── go\                         ← t9cloud daemon (Groq/Gemini/Telegram)
├── Launch-T9EditorLIT.bat/.ps1 ← ★ launchers
└── resource_Clipchamp\         ← reference material (OBS recording, Clipchamp DOM extracts)
```

> ⚠ `src\lib\components\clipchamp\**` (root me) = **purana bakwas UI**. Chheda nahi gaya.
> `Clipchamp_Bunny/` hi canonical hai.

### 3b. Installed app (taskbar wala)

```
C:\Users\pocot\AppData\Local\Programs\T9EditorLIT\
├── t9-editor-lit.exe     ← app (copy of target/release)
├── t9cloud.exe           ← cloud daemon (copy of go/bin)
├── .env                  ← API keys (copy of repo .env)
└── T9 Editor LIT.lnk    ← ★ taskbar pin yahi hai
```

Repo ka `target/release` clean ho jaye tab bhi pin zinda rehta hai — isiliye
app **copy** karke install hota hai, seedha repo path pe pin nahi.

> ⚠ Repo ka `.env` aur `go/bin/t9cloud.exe` copy hote hain — install folder
> `.gitignore` ke bahar hai (AppData), isliye git me kuch nahi aata.

---

## 4. Core architecture decisions

### 4.1 Do modes, do kaam
| Mode | Kaam |
|---|---|
| **MEDIA** | import (file manager · link/yt-dlp · Telegram · drag&drop) → probe → **DEAD AIR** workbench |
| **CUT** | transcript padho → ✕/✓ → clips drag karke reorder → live transcript update |

**Export ek mode nahi** — preview bar ke purple button se (Clipchamp jaisa).
Left rail me **2** entries. `POLISH` (text/zoom/music) **hata diya** — app ka maksad nahi hai.

### 4.2 Mode isolation
`mode.epoch` counter + `{#key mode.epoch}` → switch hote hi pichla mode ka component tree
**destroy** hota hai (hard memory drop, GC parking nahi).

### 4.3 Phantom Cut
5 GB video kabhi re-encode nahi hota. `keep` flag flip hota hai → preview player cut range ko
**skip** karta hai (`project.skipCuts`). Asli cutting sirf Export me, ek baar.

### 4.4 Edit timeline (bottom block)
Timeline **final video** hai, source nahi:

| Lane | Height | Content |
|---|---|---|
| source minimap | 7px | poora original, red = cut |
| ruler | 24px | edit time |
| T | 30px | text overlays |
| **Video** | 52px | **draggable clips**, real filmstrip, gold split dividers |
| **Audio** | 44px | kept segments ka waveform, traffic-light colours |

Playhead source ⇄ edit map hota hai (`editTimeAt` / `sourceAt`); cut ke andar ka time
**koi edit position nahi** — wahi Phantom Cut hai.

### 4.5 Traffic-light waveform
`gold` = keep · `red` = fumble/retake/galat-example · `grey` = khamoshi.

### 4.6 Keyboard flow (one-hand arcade)
`X` cut → auto-advance · `V` keep → auto-advance · `↓/↑` line nav (preview jumps too) ·
`S` split · `Ctrl+Shift+X` cut-at-playhead · `Z`/`C` then arrow = trim start/end ·
`Shift+X` then arrow = move line.
**All rebindable** — `?` → Customize tab → localStorage me yaad.

### 4.7 Split = text bhi kata
`S` (split) / `Ctrl+Shift+X` (cut here) — line ke andar split hoti hai.
**Word timings** (Whisper `words[]`) se **text bhi split hota hai**:
"I LOVE U" (10 s) cut at 4 s → rows "I" (cut) + "LOVE U" (keep).

**Groq ka ek twist:** `timestamp_granularities[]=word` bhejne pe Groq
`segments: null` deta hai aur sirf flat `words[]` array. Isliye Go daemon me
`segmentsFromWords()` fallback hai — words se pause (0.7 s) / sentence-punctuation /
14 s line-limit ke basis pe lines wapas bana deta hai.

Chain: `Groq → go/internal/cloud/cloud.go (segmentsFromWords) → model.Segment.Words
→ Rust transcripts.words (JSON blob) → frontend applySplitText()`.

### 4.8 SQLite cache — API sirf import pe
`project.ensureTranscript(path)`:
1. `load_transcript(db, path)` → **hit? return, network zero.**
2. Miss → `extract_audio_chunks` → `POST /v1/transcribe` → `/v1/correct` → `/v1/analyze`
   → `save_transcript(db, path, …)`.
3. Agli baar: step 1 hi hit karta hai. **API kabhi dobara nahi bulta.**

### 4.9 Canonical path — DB ka key
`transcripts.source_path` SQLite ka key hai, isliye **string** stable hona chahiye,
file wahi hone se kaafi nahi. Pehle path `cwd` se banta tha
(`…/Clipchamp_Bunny/../resource_Clipchamp/clip.mp4`), aur `cwd` badalne se
**same file ka naya row** banta — cache miss → dobara API call → aur app
taskbar se khulti to **mock transcript** dikhata.

Ab `transcript::canonical_path()` har path ko absolute + `..`-free + symlink-free
karta hai (Windows ka `\\?\` prefix bhi hatata hai). `transcripts`, `projects`
aur `media_cache` — teenon ke keys canonical hain, aur `migrate_paths()` purane
rows ko naye spelling pe fold kar deta hai.

### 4.10 App kholte hi DASHBOARD (landing screen)

Ab app **dashboard par khulta hai** — taskbar icon, desktop shortcut, launcher
script, sab se pehle yahi screen. Reference: `T9 Editor LIT Dashboard.png`.

Pehle app seedha editor kholta tha (last project). Ab:

1. `app.view = 'home'` → **HomeDashboard** — ek hi SQLite query (`load_projects`)
   se project list, turant paint.
2. Card pe click → `project.loadFromBackend(path)` + `mode.set('cut')` → editor.
3. "Create a new video" → editor ka **Media mode** (blank project).
4. "Import media" → file picker → naya project → editor.
5. Editor ka top-bar 9-dot button → wapas dashboard.

**Startup me project load NAHI hota** (`project.init()` ab `main.ts` se hat gaya).
Dashboard ko instantly paint karna hai — probe + waveform + transcript ka kaam
tab hota hai jab user wo project maange, home screen fade in hone ke dauraan
nahi. Ye zero-RAM rule ka seedha application hai.

Dashboard **editor ki koi feature nahi hatata** — DEAD AIR workbench, transcript
pipeline, cut/export, shortcuts — sab editor ke andar hi rehte hain.

### 4.10b Dashboard ka data — sab kuch real

| Card pe kya dikhta hai | Kahan se aata hai |
|---|---|
| Naam, duration | `projects` table (SQLite) |
| "Edited 3 hours ago" | `projects.last_opened` (unix seconds) |
| File size | Rust `probe_media` (SQLite me cached) |
| Thumbnail | Rust `extract_poster` — **ek** frame, disk cache (`cache/posters/<key>.jpg`) |
| Storage bar | project files ka total vs drive ka total (Rust `drive_space`) |

`extract_poster` alag command hai `extract_thumbnails` se — woh poora video
1 fps pe decode karta hai (2 ghante = poora decode). Card ko sirf **ek still**
chahiye, to woh `-ss` se seedha uss frame pe jump karke ek JPEG banata hai.
Cache key = path + size + mtime, dobara kholne pe FFmpeg chalta hi nahi.

**Poster ek-ek karke** bante hain (ek time pe ek FFmpeg child) — aath cards
ke aath FFmpeg child parallel chala to wahi CPU burn ho jaata jo ye app
banna hi chahta hai.

### 4.10c Trash — record ka bin, video ka nahi

Dashboard ka "Trash" ek **asli** table hai (`trash`): project ki row `projects`
se nikal kar `trash` me jaati hai. **Video file kabhi nahi delete hoti** —
sirf app ka record hatta hai, isliye "Restore" foran wapas aata hai aur
transcript ko dobara banane ki zaroorat nahi padti. "Delete record" bhi sirf
record hatata hai; user ka footage disk pe safe rehta hai.

Rust: `transcript::trash_project / restore_project / load_trash / purge_trash`.

### 4.10e Status bar — asli meters (RAM / disk / net / clock)

Footer ab 5 honest readings dikhata hai, **ek Rust call per second**:

| Item | Kahan se | Kitna costly |
|---|---|---|
| **App** — app ka apna disk (DB + cache + logs) | `meters.rs` → `dir_size()` (streaming walk) | 20s me ek baar, TTL cache |
| **Device** — drive used / total | `sysinfo_ext::drive_space()` | ek disk list, ~1 ms |
| **Net** — ↓ / ↑ bytes per second | `sysinfo::Networks` interface counters | ek interface list, ~1 ms |
| **RAM** — app ka tree + machine used/total | shared `memory::MemoryProbe` | memory + process table refresh |
| **Clock** — Delhi ka time/date/day | `Intl` (Asia/Kolkata), zero cost | — |

**Net OS counters se aata hai, speed-test se nahi.** Speed-test khud traffic
kharcha karta hai aur "speed" se "speed" measure karta hai — woh number link
ka nahi, probe ka hota hai. OS counters wahi number dete hain jo Task Manager
deta hai, bina kisi traffic ke.

**Ek interface, sabse wala:** har adapter ka alag count karna VPN tunnel +
physical link ko double count karta. Isliye sabse zyada traffic wala adapter
hi report hota hai (tooltip me interface ka naam).

**Set system clock:** `set_system_clock` → PowerShell `Set-TimeZone` +
`Set-Date`. Windows me ye **admin** maangta hai — error aata hai to asli
wajah dikhti hai ("administrator chahiye"), jhootha success nahi.

**RAM impact zero:** kuch buffer nahi banta, koi file read nahi hoti (sirf
`metadata`), numbers hi IPC se cross karte hain. Polling **sirf tab** chalti
hai jab koi screen ye bar dikha rahi ho (`meters.start()` / `stop()`, ref-counted).

Reusable: `stores/meters.svelte.ts` (store) · `components/SystemFooter.svelte`
(bar) · `components/WorldClock.svelte` (popup) · `src-tauri/src/meters.rs`
(Rust). Editor ka apna RAM meter abhi apna polling rakhta hai — future me
wahi store use kar sakta hai.

### 4.10d Motion — feedback, decoration nahi
Rules (AGENTS.md §1 ke saath): sirf `opacity` + `transform` animate hote hain
(compositor-only — layout/repaint nahi), kuch loop nahi karta (sirf sach me
wait karne wala spinner), aur sab kuch **Windows ke "animations off"** pe
band ho jaata hai (`prefers-reduced-motion` → duration/delay collapse).

| Kahan | Kya | Time |
|---|---|---|
| Dashboard khulte hi | opacity fade-in | 180 ms |
| Editor dashboard se | fade + 12 px slide | 200 ms |
| "Create a new video" hover | blue bright + 1 px up | 150 ms |
| "Create a new video" press | `scale(0.98)` (instant) | — |
| Project card hover | 2 px up + border bright + ⋮ dikhta hai | 150 ms |
| Card stagger | 24 ms gap, 8 cards tak | 200 ms |
| Search focus | border ka rang badalta hai, size nahi | 150 ms |
| Storage bar | width animate hoti hai jab **real** value aata hai | 400 ms |

CSS `app.css` me hai (`t9-fade-in` · `t9-slide-in` · `t9-card-in` · `t9-spin`).

### 4.11 Daemon khud app ke saath uthta hai
`ensure_daemon()` (Tauri `setup` hook): port 7878 free ho to `t9cloud.exe`
spawn hota hai — `CREATE_NO_WINDOW` (console nahi dikhta), output
`%APPDATA%\com.engrtarun.t9editorlit\t9cloud.log` me. Isiliye taskbar se
click karna kaafi hai, terminal ki zaroorat nahi.

Daemon kahan se dhoondha jaata hai: app ke saath (installed layout), phir
`go/bin/t9cloud.exe` (repo layout). `.env` bhi wahi se.

---

## 5. Backend seams (backend agent yahan plug karega)

| UI jagah | Kya plug hoga | State |
|---|---|---|
| `stores/cloud.svelte.ts` → `connect(id)` | telegram → `POST /v1/vault/authorise` (QR) + `/v1/vault/upload`; gemini → `/v1/analyze`; groq → `/v1/transcribe` | stub (mock connect) |
| `CloudMenu.svelte` → QR modal | real QR from `GET /v1/vault/authorise/{id}` | **placeholder QR** |
| `lib/pipeline.ts` | transcribe → correct → analyze | ✅ **LIVE, tested** |
| `stores/project.svelte.ts` → `ensureTranscript` | SQLite-cache + pipeline | ✅ **LIVE** |
| `media.svelte.ts` → `addPath` | Rust `probe` + `extract_thumbnails` | ✅ wired |
| `WaveTimeline` video lane | Rust `extract_thumbnails` → real filmstrip | ✅ wired (visible in screenshots) |
| `ExportMode` | Rust `start_export` (hybrid/copy/encode) | ✅ wired, progress event |
| `lib/ipc.ts` → `downloadFromUrl` | Rust `download_from_url` (yt-dlp) | ✅ wired |
| **`HomeDashboard` → `loadProjects`** | Rust `load_projects` | ✅ **wired** |
| **`HomeDashboard` → `extractPoster`** | Rust `extract_poster` — ek frame, disk cache | ✅ **wired** |
| **`HomeDashboard` → `driveSpace`** | Rust `drive_space` — drive ka free/total | ✅ **wired** |
| **`HomeDashboard` → trash** | Rust `trash_project` / `restore_project` / `load_trash` / `purge_trash` | ✅ **wired** |
| **Go `Segment.Words`** | word timings daemon se | ✅ **DONE** — `model.Word`, `groqWord`, `segmentsFromWords()` |
| **Telegram vault → media library** | daemon se file download karke library me daalna | 🟡 **backend DONE** — daemon me restore poora hai: `GET /v1/vault/manifests` (menu) + `POST /v1/vault/download` (202 job; per-part digest-verify, resume record, temp files `destDir` me) — `go/internal/vault/restore.go` + `telegram.go FetchParts`; UI ka import call lena baaki |
| **Setup card "Save & Test"** | daemon `POST /v1/keys/probe` — body ka key ek models-list call se prove hota hai, log/echo kabhi nahi; empty key daemon ke configured key ka re-check | ✅ **wired** (test coverage: 401/429/500/400 + key never echoed) |

### Telegram vault ke liye `.env` me ye **khali** hain
```
TELEGRAM_API_ID=      ← fill karo (my.telegram.org se)
TELEGRAM_API_HASH=    ← fill karo
TELEGRAM_TARGET_CHAT= ← fill karo
TELEGRAM_2FA_PASSWORD=
```
Isi wajah se daemon `vault: TELEGRAM_API_ID / API_HASH not set` bolta hai.
`GROQ_API_KEY` aur `GEMINI_API_KEY` **set hain** → transcribe + analyze dono `ready` hain
(verified: `GET /healthz` → `{"cloud":{"analyze":"ready","transcribe":"ready"}}`).

---

## 5b. Doosra agent parallel me kaam kar raha hai

Is repo pe **TARUN DILWAL (tera doosra session)** bhi commit karta hai. Uska
kaam **Go daemon side** hai — mera kaam **app/UI side**. Merge dono ke beech
hota hai.

Uske commits (jo maine dekhe):
- `14b98b7` — **net speed probe Go daemon me** (`go/internal/netspeed`, 4 parallel
  sockets + tuned receive buffers) + `GET /v1/net/speed?windowMs=`. Frontend me
  `measureNetworkSpeed()` ab **daemon ko prefer** karta hai, browser fetch sirf
  fallback hai. ✅ dono merge ho chuke hain, conflict nahi.
- `dd9f770` — `media` commit.
- `5e69d85` / `c7c184e` / `2552101` / `d047219` — **ab woh app par bhi kaam
  kar raha hai**: shared `components/UpdateButton.svelte` (dashboard + editor
  dono me), status bar (12-hour clock + battery, `src-tauri/src/meters.rs`),
  aur mera `build.json` parse bug fix (`update_ready` ko `#[serde(default)]`).

**Rule:** Go side ka kaam wahi karega (daemon = cloud brain), frontend side mera.
`lib/ipc.ts` shared hai — usme dono ka kaam aata hai, dhyan rakhna.

**Doosre agent ke saath kaam karte waqt:** `git status` me uske pending changes
dikhte hain — unhe **stage mat karo**, wo uski baar ki hain. Sirf apne scope ko
stage karo.

> ⚠ **Ab dono `Clipchamp_Bunny/` me kaam kar rahe hain.** Isliye:
> - `TopBar.svelte` ka inline update-block hata diya — ab `<UpdateButton />`
>   use hota hai (uska shared component, dashboard pe bhi yahi chalta hai).
> - `lib.rs` aur `project.svelte.ts` dono touch ho sakte hain — **chhota edit**
>   karo, aur build se pehle `npm run check` chalao (uska `flush()` jaisa
>   adhoora method tree me reh gaya tha).
> - Uski taraf se handoff [`docs/AGENT_STATUS.md`](../../docs/AGENT_STATUS.md)
>   me padha jata hai — wahan "one thing for the next agent" likha hota hai.

---

## 6. Commands

```bat
:: repo root se
.\Launch-T9EditorLIT.bat            :: release exe (instant). Pehli baar 10-15 min build.
.\Launch-T9EditorLIT.ps1            :: same, PowerShell
.\Launch-T9EditorLIT.ps1 -Dev       :: cargo dev + hot reload
.\Launch-T9EditorLIT.ps1 -NoDaemon  :: t9cloud chala ke

cd Clipchamp_Bunny
npm install
npm run dev          :: browser, http://localhost:5174  (baked dummy media)
npm run app          :: tauri dev
npm run app:build    :: release exe + MSI + NSIS
npm run check        :: svelte-check
npm test             :: node --test
```

### Taskbar wala app — update kaise karte hain

Har deploy ek **work order** hai, sirf build nahi:

```powershell
cd Clipchamp_Bunny

pwsh -File tools\deploy.ps1 -Interactive
# ya:
pwsh -File tools\deploy.ps1 `
  -Agent "opencode" `
  -Model "opencode/deepseek-v4.1-flash-free" `
  -Task "fix the export button state" `
  -Why "the button stays disabled after a successful export" `
  -EtaMinutes 25 -Scope both

pwsh -File tools\deploy.ps1 -Status     # ledger: active + queue + recent
pwsh -File tools\deploy.ps1 -Doctor     # installed app + daemon health
pwsh -File tools\verify-install.ps1     # real data, 0 API calls, MB/s live
```

Poora form/queue/exit-code contract:
[`docs/AGENT_DEPLOY_PROTOCOL.md`](../../docs/AGENT_DEPLOY_PROTOCOL.md).

**Flow:** code change → `tools\deploy.ps1` → ledger work order → build +
install/stage + daemon → hash verify → `shipped`. Taskbar shortcut ka path
stable hai (`%LOCALAPPDATA%\Programs\T9EditorLIT\t9-editor-lit.exe`), repo ke
`target\release` par nahi.

> App **band** ho to build seedha install hota hai. App **chal raha** ho to
> build `t9-editor-lit.new.exe` ke roop me stage hota hai; app band karne ki
> zaroorat nahi, aur install folder ko haath se chhedna nahi.

### 4.12 Self-update — app khud naya build detect karta hai

Desktop app **khud update hota hai**, OpenCode jaisa chhota "Update" button:

| Kya | Kahan |
|---|---|
| Marker file | install folder me `build.json` (`buildId`, `appSha256`, `mode`, `daemonVersion`, timestamps) |
| Staged build | `t9-editor-lit.new.exe` (+ `t9cloud.new.exe`) |
| Detect | `installed_build()` → app har **5 s** me marker + staged exe dekhta hai |
| Apply | `apply_staged_update()` → helper app + daemon swap karke restart |
| UI | top bar me chhota "Update" pill **sirf staged exe hone par** |

Marker timestamp ya version badalne se button nahi aata — **staged executable**
hi trigger hai. Isliye false "update available" nahi dikhta.

**Flow:** code change → `deploy.ps1` → app chal raha hai to **stage** hota
hai (exe lock nahi toot-ta) → app me "Update" → click → naya build (app +
daemon) swap hokar restart. Restart ke baad app marker ko `mode: installed`
kar deta hai aur `appliedAtUnix` likhta hai (helper JSON edit nahi kar sakta),
warna `-Doctor` hamesha "staged" dikhata rehta.

### 4.13 Do agents ka bridge — `deploy.ps1` hi ek hi darwaza hai

Mera kaam **app/UI** (`Clipchamp_Bunny/`), doosre ka **Go daemon** (`go/`).
Desktop tak dono ka kaam ek hi raaste se pahunchta hai:

```text
Agent A: app/UI change → commit
Agent B: go/ change     → commit
        ↓
deploy.ps1 (SQLite ledger, ek active deploy)
        ↓
installed app + t9cloud daemon + build.json + evidence
```

`deploy.ps1` khud **daemon rebuild** karta hai jab `go/**/*.go`, `go.mod`,
`go.sum` ka hash binary ke `-version` se alag ho. Daemon idle ho to turant
restart, busy ho to `t9cloud.new.exe` stage; app band ho aur job in-flight ho
to 90 s wait karta hai, phir **bina job kill kiye** fail karta hai.

**Isiliye doosre ka koi bhi commit, ek `deploy.ps1` ke baad desktop pe live
ho jata hai.** Usse batana: "desktop pe dekhne ke liye `tools\deploy.ps1`
chalao" — bas. Status chat me nahi, `deploy.ps1 -Status` me dekho.

**Sarkari engine** (`sarkari_deploy/`) wahi darwaza hai, tez version:

- `-Check` → 10-second type check (TS + Svelte + Rust), koi build nahi
- 4-minute live pulse, canary smoke test, `.prev.exe` se auto-rollback
- **Queue wahi SQLite ledger hai** (`sarkariLedger.ps1`): `request` → `claim`
  → `heartbeat` → `finish`. Sarkari ka apna JSON record sirf report hai,
  queue nahi. Isiliye `deploy.ps1 -Status` dono engines ko dikhata hai
- **Deploy lock** (`%LOCALAPPDATA%\T9EditorLIT\deploy\deploy.lock`) dono ke
  beech hai — do agents ek saath build/install kabhi nahi karte
- **Har work order ka apna target folder** (`.t9\targets\<workId>`) — do
  builds ek hi `target/` me likhte to cargo lock pe atak-te aur 8 GB machine
  pe linker OOM hota
- Doosre agent ka order kabhi expire mat karo: `tools\deploy-ledger-reclaim.mjs`
  25-minute floor rakhta hai (queued TTL 15 m + 10 m margin). Galat hua to
  `tools\deploy-ledger-restore.mjs restore --id WO-...`

**t9cloud** (cloud AI ke liye):
```powershell
cd C:\Users\pocot\Music\T9EditorLIT
.\go\bin\t9cloud.exe -env .\.env
# check: Invoke-WebRequest http://127.0.0.1:7878/healthz
# → {"cloud":{"analyze":"ready","transcribe":"ready", …}}
```

**SQLite** (app ka state, disk pe):
```
%APPDATA%\com.engrtarun.t9editorlit\nanamicut.db
  tables: transcripts · projects · media_cache
  transcripts: source_path, id, start_secs, end_secs, text, keep, flag,
               original_text, words(JSON)
```
Inspect karne ke liye Node ka built-in `node:sqlite` (Node 24) — repo me sqlite3 CLI nahi hai.

**Media bake** (browser mode ka dummy):
```bash
cd Clipchamp_Bunny && node tools/generate-media.mjs
```

---

## 7. Kya bana hai (verified)

- [x] Clipchamp-parity shell: top bar, 58px labelled rail, preview bar, 52px right rail
- [x] 2-mode zero-RAM shell (`{#key}` destroy)
- [x] Cut dashboard: preview + transcript ✓/✕ (virtual scroll, ~30 rows DOM me) + edit timeline
- [x] Phantom Cut (playback skips cut ranges)
- [x] Traffic-light waveform (real peaks, normalised)
- [x] Real filmstrip (Rust `extract_thumbnails`, 1 fps, 160×90)
- [x] **Drag & drop**: clip uthake reorder → transcript live reorder
- [x] **Split visible** — gold divider on timeline + line count 38→39
- [x] **Cut at playhead** (`Ctrl+Shift+X`) — split + drop head
- [x] Dead-air workbench (threshold slider default 3 s = Clipchamp rule, silence list, cut-all)
- [x] **Real pipeline**: Rust chunks → Groq Whisper → correct → Gemini flags → SQLite
      — *verified live*: 31 real Hindi lines for the OBS recording, all with word timings
- [x] **SQLite cache** — API sirf import pe
      — *verified live*: app restart → daemon `completed` count **unchanged** (0 new calls)
- [x] **Canonical path keys** — `..`-free, absolute, stable; `transcripts` /
      `projects` / `media_cache` teeno migrate ho jaate hain
- [x] **Dummy zero on desktop** — app apna **last project** kholta hai (real
      transcript, SQLite se); demo sirf tab jab file sach me ho; warna khali
      editor. Mock lines sirf browser mode me.
- [x] **Taskbar pin** — `tools\deploy.ps1` build → install → pin; stable install
      path `%LOCALAPPDATA%\Programs\T9EditorLIT\`
- [x] **Daemon auto-start** — app `t9cloud` ko khud uthata hai (hidden), to
      taskbar se click karne se cloud bhi chalta hai
- [x] **Word-level timings end to end** — Groq `timestamp_granularities[]=word` →
      daemon `segmentsFromWords()` → `model.Segment.Words` → `transcripts.words` →
      split cuts the text too
- [x] **Home dashboard** — app ka landing screen (taskbar / shortcut / launcher se
      yahi khulta hai). Reference: `T9 Editor LIT Dashboard.png`
- [x] **Dashboard ka real data** — duration + "edited X ago" (SQLite), file size
      (cached ffprobe), thumbnail (FFmpeg se **ek** frame, disk cache), storage
      bar (drive ka real free/total)
- [x] **Trash** — project ki row `projects` → `trash` table; **video file kabhi
      nahi delete hoti**; restore foran wapas
- [x] **Motion** — 180 ms fade · 2 px card lift · 24 ms stagger · `prefers-reduced-motion`
      se sab band
- [x] Import: file manager (multi) · link (yt-dlp) · Telegram vault (QR) · drag&drop
- [x] New file = new project; purana library me
- [x] **Full Clipchamp shortcut set** + **rebindable** (localStorage)
- [x] Honesty meter: RAM used/total · app MB · **real** network speed (MB/s + Mbps) · click → OS/CPU/uptime/RAM/drives
- [x] Rust `transcripts.words` column (JSON blob) + safe migration
- [x] Release exe + MSI + NSIS installer
- [x] `?` shortcut sheet with **Customize** tab

## 8. Bacha hai

- [ ] **Telegram vault → media library** (download karke import) — daemon half ✅ (restore job + `GET /v1/vault/manifests` / `POST /v1/vault/download`); UI ka import call baaki
- [ ] **Bachay hue huaam** ko split karte waqt text edit karne ka UI (inline rename on a split half)
- [ ] **Polish mode** (text/zoom/music) — deferred, app ke do kaam se bahar hai
- [ ] Root ka **bakwas UI** delete karna (`src/lib/components/clipchamp/**`)
- [ ] `Clipchamp_MIMO/` folder abhi bhi khaali hai
- [ ] Cut-gap **drag-resize** (cut ki jagah adjust karna timeline pe)
- [ ] Dashboard par **multi-select** (Ctrl-click se kai projects ek saath move to trash)

---

## 9. Gotchas (jo maine galti se seekha)

1. **Release exe lock** — `npm run app:build` ek running exe ko overwrite nahi kar sakta
   ("Access is denied"). Taskbar app ko `Stop-Process` mat karo; `deploy.ps1` app band ho to
   seedha install karta hai, chal raha ho to `t9-editor-lit.new.exe` stage karta hai.
2. **Build ke beech me `npm run build` mat chalao** — `dist` ka hash badal jaata hai aur
   Tauri build fail hota hai ("failed to read asset … dist/assets/…").
3. **`structuredClone` Svelte ke reactive proxy pe fail hota hai** — plain `{...l}` copies use karo.
4. **Split ids duplicate** → Svelte `each_key_duplicate` → DOM freeze. Unique tag chahiye.
5. **Undo sirf `keep` flags store karta tha** → split/trim undo nahi hote the. Poori line array snapshot karo.
6. **Network speed measurement** — poora `fetch` time mat lo (DNS+TLS+TTFB included hota hai);
   **first body byte** se clock start karo, warna 40 Mbps line 2 MB/s dikhti hai.
7. **Menu panel ke andar render karna** → ancestor stacking context use chhupa deta hai aur
   click-away nahi hota. **App root pe render karo** (`stores/menu.svelte.ts`).
8. **Relative `-env` path** Go daemon ke liye nahi chalta — **absolute path** do.
9. **Rust modules `crate::` use karte hain** — `#[path]` se nest karne pe `crate::media`
   resolve nahi hota. Modules crate-root pe declare karo.
10. **`.env` me empty values** silently rehte hain (vault disable ho jaata hai) — check karo.
11. **Release build 15+ min leta hai** — profile me `lto = "thin"` + `opt-level = 3` +
    `codegen-units = 1`. Link phase me `rustc` ~600 MB RAM leta hai aur CPU pe
    ata rehta hai — **hang nahi hua, bas slow hai**. Beech me `npm run build`
    mat chalao (dist ka hash badal jaata hai). Iteration ke liye `npm run app`
     (tauri dev) use karo - wo LTO nahi karta. Profile me **`lto = "thin"`** hai: link 3-4× tez,
     binary thoda bada, runtime speed same. Isiliye `tools\deploy.ps1` ab practical hai.
12. **`cwd` pe depend mat karo** - app ka data path `cwd` se banta tha, to
     taskbar se launch karne pe dummy transcript aa raha tha. Ab har path
     canonical hai aur `resume_project()` last project khulta hai.
13. **Taskbar pin ka shell verb Win11 pe kaam nahi karta** -
     `InvokeVerb("taskbarpin")` silent fail karta hai. Kaam karta hai: shortcut ko
     `%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar`
     me copy + `explorer.exe` restart. (`tools\pin-taskbar.ps1` dono karta hai.)
14. **Taskbar pin repo path pe mat rakho** - `target/release` `cargo clean` pe
     mita jayega aur pin toot jayega. Installed copy use karo.
14b. **⚠ EK SAATH BUILD MAT KARO** - do agents ke `tauri build` ek saath chale
     to `dist/` aur crate ka source interleave ho jata hai, aur **binary
     MIXED** banta hai. Ab `tools\build.ps1` pehle **lock** leta hai
     (`src-tauri\target\.build-lock`) - doosra build intezaar karta hai, race
     nahi karta. **Bina lock ke kabhi `npx tauri build` mat chalao.**
14c. **⚠ STALE ASSET CACHE** - Tauri ka build script **embedded frontend ke
     asset list ko apne output folder me cache karta hai** aur use refresh
     nahi karta. Naya `dist/` ban jaye to bhi binary me **purana frontend**
     jata hai. Symptom: command source me hai par binary me nahi, aur app
     chup-chup "command not found" karta hai. `tools\build.ps1` har build se
     pehle `src-tauri\target\release\build\t9-editor-lit-*\out` **delete** karta
     hai - isse build script dobara chalta hai aur current asset list banti
     hai. (`tauri-codegen-assets` me 36 stale hashed files accumulate hue
     the - wahi symptom tha.)
14d. **Link step ko RAM chahiye** - `link.exe` ko ~1.5 GB chahiye. 8 GB box
     pe (jahan 7 GB already busy ho) link **1181** se fail hota hai -
     "file in use" lagta hai par asal me RAM ki kami hai. `codegen-units = 1`
     ko `4` kiya gaya hai (link memory kam, binary ~1% bada). Link se pehle
     stale `vite dev`/`vite preview` servers band karo - woh 100 MB each kha
     rahe hote hain.
14e. **⚠ 7 MINUT KA RULE** - koi problem **7 minute se zyada** atke to
     **web search** karke solution nikaal. Isi rule se pata chala ki Tauri ka
     build script embedded-asset list ko cache karta hai (`tauri-codegen-assets`
     me 36 stale hashed files the) aur `codegen-units` se link ka RAM
     control hota hai. Source + binary compare karna bhi ek valid "search" hai
     - `strings` jaisa byte-scan (`node` se `indexOf`) dono taraf chalana.
14f. **⚠ `measuring` FLAG STUCK HO SAKTA HAI** - meter ka `measuring` flag
     set rahe to agla attempt `if (measuring) return` pe ruk jata hai aur
     chip **puri session me "—"** dikhata hai. `finally` me flag hamesha
     release karo, aur har request pe **timeout** rakho (fetch atka to koi
     doosra attempt chalega hi nahi).
14g. **Meter ka reading DAEMON se webview ke through lo** - dashboard ka
     greeting `/v1/greeting` hit karta hai, matlab webview daemon tak
     pahunch sakta hai ✓. Rust command second try rakho (us build me nahi
     hota). `T9_TARGET_DIR` set karne se build **apne target folder** me
     jata hai (`CARGO_TARGET_DIR` bhi set karna padta hai!) - do agents ke
     build ek doosre ka `out\resource.lib` delete kar ke `LNK1181` de rahe
     the.
15. **Dashboard pe startup me project mat kholo** - `project.init()` ek baar
    chala raha tha aur app ko 2-3 second late karta tha (probe + waveform +
    transcript). Ab list ek SQLite query se aati hai aur project tab load hota
    hai jab user use maange.
16. **Card thumbnail ke liye `extract_thumbnails` mat use karo** - woh 1 fps pe
    poora video decode karta hai. `extract_poster` ek frame nikalta hai
    (`-ss` input seek) - 5 GB file pe bhi ~200 ms.
17. **Poster ek saath mat banao** - 8 projects = 8 FFmpeg child ek saath =
    CPU spike. Queue chalao, ek-ek karke, aur beech me UI ko frame do.

---

## 10. Commit convention (AGENTS.md)

```bash
git add <scope>
git commit -m "feat(scope): <what>" --author="Agent Bunny <agent@local>"
git push   # ← NEVER. Sirf user karta hai.
```

---

## 11. Clipchamp se mila hua, par JAAN-BUJH KAR alag (ye mat badalna)

- Rail me 2 entries (Media, Cut) — Clipchamp ke 6 panel-switcher ki jagah
- Export rail me nahi, preview bar me
- Right panel 340px transcript (Clipchamp ka 48px CC rail)
- Left panel "My media" 248px
- **T9 LIT blue** accent `#4D8DFF` (Clipchamp purple / purani Nanami gold ki jagah) — cut/keep ke liye. Token ka naam `nc-brand` hai (`nc-gold` bas alias), values branding board se (`T9 Editor LIT Branding Board.png`)
- App icons branding board se generate hue (`npx tauri icon tools/branding/app-icon.png`), src-tauri/icons/ me
- **Brand mark traced hai, hand-drawn nahi** — `tools/branding/trace-mark.mjs` board ke original pixels se `src/lib/components/dashboard/BrandMark.svelte` banata hai. Board ke apne rule: "Use original, high-quality assets". Script apna hi quality gate chalaata hai (trace vs source ka interior pixel match 100% hona zaroori) — agar trace bigad to script fail hota hai
- Wordmark font `Agency FB` (`--font-brand`) — board ke wide/squarish techno face ka closest Windows face, koi font file ship nahi karni parti
- App ka version number `tauri.conf.json` se aata hai (`getVersion()`), hardcode nahi — warna UI jhooth bolta hai
- `X` = cut (Clipchamp me `X` = move item) → hamare `Shift+X`+arrow = move
- `↑/↓` = line nav (Clipchamp me timeline scroll)
- 3-second silence rule Clipchamp ka hi hai
