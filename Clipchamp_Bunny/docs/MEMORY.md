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
│   │   ├── mock.ts             ← fallback transcript (scaled)
│   │   ├── media.ts            ← baked-asset loader (browser mode)
│   │   ├── stores\             project · player · mode · layout · media · cloud · toast · menu · keys
│   │   └── components\         TopBar · PreviewBar · ModeRail · RightRail · CloudMenu
│   │                            SystemMeter · ContextMenu · MenuIcon · ShortcutsHelp · Toasts
│   │                            cut\{VideoPreview,TranscriptPanel,WaveTimeline}
│   │                            media\{MediaPanel,MediaTile}
│   │                            modes\{IngestMode,CutMode,ExportMode}
│   ├── src-tauri\              ← Tauri shell; engine root se #[path] se share hota hai
│   ├── public\assets\          ← baked demo media (waveform.json, thumbs/, media.json)
│   └── tools\generate-media.mjs ← demo media baker (real FFmpeg commands)
├── src-tauri\src\              ← ★ SHARED Rust engine (transcript.rs, export.rs, waveform.rs…)
├── go\                         ← t9cloud daemon (Groq/Gemini/Telegram)
├── Launch-T9EditorLIT.bat/.ps1 ← ★ launchers
└── resource_Clipchamp\         ← reference material (OBS recording, Clipchamp DOM extracts)
```

> ⚠ `src\lib\components\clipchamp\**` (root me) = **purana bakwas UI**. Chheda nahi gaya.
> `Clipchamp_Bunny/` hi canonical hai.

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
| **Go `Segment.Words`** | word timings daemon se | ✅ **DONE** — `model.Word`, `groqWord`, `segmentsFromWords()` |
| **Telegram vault → media library** | daemon se file download karke library me daalna | ❌ **TODO** |

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

**t9cloud** (cloud AI ke liye):
```powershell
cd C:\Users\pocot\Music\T9EditorLIT
.\go\bin\t9cloud.exe -env .\.env
# check: Invoke-WebRequest http://127.0.0.1:7878/healthz
```

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
- [x] **SQLite cache** — API sirf import pe
- [x] Import: file manager (multi) · link (yt-dlp) · Telegram vault (QR) · drag&drop
- [x] New file = new project; purana library me
- [x] **Full Clipchamp shortcut set** + **rebindable** (localStorage)
- [x] Honesty meter: RAM used/total · app MB · **real** network speed (MB/s + Mbps) · click → OS/CPU/uptime/RAM/drives
- [x] Rust `transcripts.words` column (JSON blob) + safe migration
- [x] Release exe + MSI + NSIS installer
- [x] `?` shortcut sheet with **Customize** tab

## 8. Bacha hai

- [ ] **Telegram vault → media library** (download karke import)
- [ ] **Bachay hue huaam** ko split karte waqt text edit karne ka UI (inline rename on a split half)
- [ ] **Polish mode** (text/zoom/music) — deferred, app ke do kaam se bahar hai
- [ ] Root ka **bakwas UI** delete karna (`src/lib/components/clipchamp/**`)
- [ ] `Clipchamp_MIMO/` folder abhi bhi khaali hai
- [ ] Cut-gap **drag-resize** (cut ki jagah adjust karna timeline pe)

---

## 9. Gotchas (jo maine galti se seekha)

1. **Release exe lock** — app chal raha ho toh `npm run app:build` fail hota hai
   ("Access is denied"). Pehle `Stop-Process` karo.
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
- Nanami **gold** accent (Clipchamp purple) — cut/keep ke liye
- `X` = cut (Clipchamp me `X` = move item) → hamare `Shift+X`+arrow = move
- `↑/↓` = line nav (Clipchamp me timeline scroll)
- 3-second silence rule Clipchamp ka hi hai
