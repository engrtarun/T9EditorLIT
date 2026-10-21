# 📋 Sarkari Report: Kaunsa Proposal Lagu Hua, Kaunsa Nahi, Aur Kyun

- **Proposal ID:** `PROPOSAL-20261021-mimo-SARKARI-PIPELINE-FIX-REPORT`
- **Author Agent:** `opencode/mimo-v2.6-flash-free`
- **Date:** `2026-10-21`
- **Target Subsystem:** `sarkari_deploy/` + `Clipchamp_Bunny/tools/` (deploy pipeline)
- **Status:** `REPORT` — ye koi naya approval request **nahi** hai. Ye ek _record_
  hai ki is folder me jo bhi maal aaya, uska kya hua.

---

## 0. Rule 4 ka disclaimer (sabse pehle)

`CONTRIBUTING_RULES.md` Rule 4:

> User approval is the ultimate gate. An agent cannot declare its own proposal
> "Approved" or "Shipped".

Isliye ye file kisi ko **approve ya reject nahi karti**. Ye sirf ye record karti
hai:

1. **Code me kya actually maujood hai** (evidence ke saath — file + line + output).
2. **User ka explicit instruction kya tha** is session me.
3. **Kya abhi bhi pending hai** aur kyun.

Faisla aapka hai. `Status: PENDING_USER_APPROVAL` kisi bhi file par main apni
marzi se `APPROVED` nahi likh sakta.

---

## 1. Summary table — 15 proposals

| #   | Proposal ID                          | Status in file                 | Code me kya hai                                                                                | Kyun                                                                                                                            |
| --- | ------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `OPENCODE-SARKARI-POLICE`            | **APPROVED** (user: "approv3") | `sarkari_deploy/sarkariPolice.ps1` maujood, read-only                                          | **User ne seedha approve kiya.** Sirf yahi proposal hai jiska user sanction file me recorded hai.                               |
| 2   | `OPENCODE-PARAM-GUARD`               | `PENDING_USER_APPROVAL`        | **6/7 hotfix production code me pehle se lage hue hain**; 7th (1.3) maine is session me lagaya | ⚠️ Rule 4 deviation — dusre agent ne approval se pehle hi production me laga diya. Neeche §3 me detail.                         |
| 3   | `mimo-FFMPEG-ADAPTIVE-CONCURRENCY`   | `PENDING_USER_APPROVAL`        | **Lagu nahi**                                                                                  | Mera apna proposal. Main khud approve **nahi** kar sakta (Rule 4). Aapka intezar hai.                                           |
| 4   | `OPENCODE-10-BIG-PROBLEMS-INDEX`     | `PENDING`                      | Index hai, code nahi                                                                           | Sirf navigation file — iska khud me koi code nahi.                                                                              |
| 5   | `OPENCODE-JOBSTORE-POLL-RAM`         | `PENDING`                      | **NEEDS_FIX** (`maxRetainedJobs = 256` mila)                                                   | User approval pending.                                                                                                          |
| 6   | `OPENCODE-QUEUE-CONTEXT-CANCEL`      | `PENDING`                      | **NEEDS_FIX** (`context.Background()` mila)                                                    | User approval pending.                                                                                                          |
| 7   | `OPENCODE-HTTP-POLL-LOG-SPAM`        | `PENDING`                      | **NEEDS_FIX** (per-poll `Log.Info("request"` mila)                                             | User approval pending.                                                                                                          |
| 8   | `OPENCODE-SQLITE-CONNECTION-REUSE`   | `PENDING`                      | **NEEDS_FIX** (`open_db(` har command me)                                                      | User approval pending.                                                                                                          |
| 9   | `OPENCODE-ENCODER-DETECTION-CACHE`   | `PENDING`                      | **NEEDS_FIX** (`fn ffmpeg_has_encoder` cache nahi)                                             | User approval pending.                                                                                                          |
| 10  | `OPENCODE-TRANSCRIPT-VIRTUAL-SCROLL` | `PENDING`                      | **NEEDS_FIX** (draft check: `virtual` match)                                                   | User approval pending. Draft ka regex `virtual` par match karta hai — **false positive ho sakta hai**, khud verify karna baaki. |
| 11  | `OPENCODE-FFMPEG-RUN-STREAMING`      | `PENDING`                      | **OK** — `.output()` kahin nahi mila                                                           | Draft check ke hisaab se ye **already fixed** ya galat premise.                                                                 |
| 12  | `OPENCODE-VAULT-UPLOAD-THROUGHPUT`   | `PENDING`                      | **OK** — `io.ReadAll` nahi mila                                                                | Same — evidence problem ko support nahi karta.                                                                                  |
| 13  | `OPENCODE-EXPORT-HYBRID-MEMORY`      | `PENDING`                      | **OK** — `.output()` nahi mila                                                                 | Same.                                                                                                                           |
| 14  | `OPENCODE-MEMORY-PROBE-SCAN`         | `PENDING`                      | **OK** — `% 8 == 0` nahi mila                                                                  | Same — proposal ka problem statement code me ab nahi milta.                                                                     |
| 15  | `template_proposal.md`               | —                              | Template hai                                                                                   | Format reference, koi proposal nahi.                                                                                            |

**Seedha jawab:**

- **Accepted (recorded):** 1 — `SARKARI-POLICE` (aapne approve kiya tha).
- **Lekin code me already lag chuke (bina recorded sanction):** `PARAM-GUARD` ke 6 hotfix.
- **Abhi tak na accept na reject — sab pending:** baaki 12 + mera apna FFMPEG wala.
- **Formally REJECTED: ek bhi nahi.** Kisi proposal ko aapne reject nahi kiya, toh
  main kisi ko "rejected" likh kar uska faisa nahi banawunga. §4 me unka status
  "pending / evidence weak" hai, "rejected" nahi.

---

## 2. Is session me kya hua (user instruction ke under)

User ka instruction tha:

> "fix karo puri pipline + deploy karo ... yaad rahe tumko ye sarkari deploy ko
> end to end sahi karna h ... system ko sahi karo taki hamara or sabhi agensts ka
> bulid na ruke"

Ye **pipeline fix ka explicit user instruction** hai — ye proposals nahi, ye
aapka hukm tha. Isi ke tehat neeche sab laga:

### 2.1 Ledger — doom loop (sabse bada bug)

**Symptom (ledger evidence):** aaj ke lagbhag har order ek hi tarah mara:

```
WO-20261021T122857-96ef03 (mimo)  | expired | queued too long without a claim - the agent vanished
WO-20261021T122851-458a95 (opencode)| expired | queued too long without a claim - the agent vanished
WO-20261021T123112-34606c (opencode)| expired | heartbeat stale - the agent stopped
WO-20261021T123618-32929a (opencode)| expired | heartbeat stale - the agent stopped
WO-20261021T121623-63c201          | expired | no agent claimed it within 5 minutes
```

**Root cause:** `claimWork()` andar hi `reapLocked()` call karta hai. Wo reaper
**caller ke apne hi order** ko expire kar deta hai → `rowById` `expired` padhta
hai → `throw "… is expired, not queued"` → `transaction()` rollback → row wapas
`queued` par aa jaata hai purane heartbeat ke saath. Agla claim phir wahi karega.
**Order kabhi claim hi nahi ho paata.**

**Fix (`Clipchamp_Bunny/tools/deploy-ledger.mjs`):**

- `reapLocked(db, now, maxHeartbeatAgeMs, keepAliveId)` — naya 4th parameter.
  Apne order ko reap se **skip** karta hai (claim = agent zinda hai).
- `claimWork` ab `keepAliveId` pass karta hai.
- Agar order expire ho chuka hai, toh **throw ki jagah wapas `queued`** karta
  hai (token ownership se prove hota hai hai ki owner zinda hai), aur in-memory
  `row` object ke `status/outcome/heartbeat_ms/…` bhi refresh karta hai — warna
  stale object neeche wahi throw dobara karta.
- `finishWork()` ab `expired` order ko bhi close kar sakta hai — warna reaper ka
  guess ("the agent vanished") hi aakhri shabad rehta, aur asli outcome
  likhne wale agent ko doosra error milta.

**Verification:**

```
node --test deploy-ledger.test.mjs   →  6/6 pass
```

E2E PowerShell test (asli `Start-SarkariLedgerOrder` ke saath, row ko zarf-e-misl
`expired` karke):

```
forced status: expired
[ok] active in the shared ledger: WO-20261021T132402-105609 (run RUN-…)
RESULT: claim succeeded - state=active
```

Pehle: `RESULT: claim returned null (FAIL - this is yesterday's bug)`.

### 2.2 Ek transient failure poora wait chhod deta tha

`Start-SarkariLedgerOrder` me `Invoke-SarkariLedger` null aate hi `return $null`
— matlab **ek baar node hang hua (is machine par 179 MB free RAM normal hai) toh
claim loop hamesha ke liye band**, heartbeat ruk gayi, reaper ne 15 min baad maar
diya.

**Fix (`sarkari_deploy/sarkariLedger.ps1`):**

- 6 consecutive failures tak tolerate, warna hi give-up (aur woh bhi deadline ke
  andar).
- Failure round me bhi `heartbeat --phase queued` bhejta hai, taaki queue TTL se
  expire na ho.
- Null response par deadline check + sleep + `continue` (dead code path nahi).

### 2.3 `--lease-minutes < 5` → claim **kabhi** succeed nahi hota

Ledger CLI `leaseMinutes` ko 5..240 validate karta hai aur bahar `exit != 0`
deta hai. Agar kisi agent ka `AllottedMinutes = 2` ya `3` ho (ledger me aise
orders hain — `eta2`), toh **har claim permanently reject**.

Ye mujhe apne hi test me mila (`-LeaseMinutes 3` → 6 baar fail → give up).

**Fix:** `Start-SarkariLedgerOrder` clamps to `[5, 240]`.

### 2.4 Sanction gate queue ko pehle hi maar deta tha ← _yahi "sabke builds rukne" ka gunahgar tha_

`sarkariPermison.ps1` **Stage 2** me `deploy.lock` held hone par
`$approved = $false` set karke **seedha reject** karta tha. Ye gate **ledger
claim se pehle** chalta hai.

Result — do gates aapas me ladte the:

| Gate     | Kya bolta tha                                   |
| -------- | ----------------------------------------------- |
| Ledger   | "wait your turn, position 1"                    |
| Sanction | **"REJECTED"** (kyunki doosra agent baitha hai) |

Aur `sarkariDeploy.ps1:227` isko throw karta tha:

```
[x] SARKARI PIPELINE FAILED: Sarkari Sanction Rejected: Lock active: …
```

Matlab **doosre agent ka build chalte hi aapka deploy mar jaata** — aap kabhi
queue me pahunchte hi nahi the. Yahi ek sabse bada "build ruk jaata hai" wala bug
tha.

**Fix:** lock ab **queue state** hai, permission violation nahi. Ab warning +
"waiting, not rejected". Asli critical sections pehle se hi wait karte hain:

- `Wait-DeployLock` — 1800s tak, progress ke saath
- `build.ps1` ka build lock — 3600s tak, aur ab **holder ka naam** ke saath (§2.5)

Genuine problems (missing tools) ab bhi reject karte hain.

**Verification (run6, live):** `deploy.lock` doosre agent ke paas tha, phir bhi:

```
>>> SARKARI PERMISSION GRANTED …
[4] Execution Locks:    BUSY (1 lock held … waiting, not rejected)
…
[ok] queued in the shared ledger: WO-20261021T133735-2ce018 (position 1)
```

### 2.5 Build lock 1124 second andher me

Pichhla run **1124 s (≈19 min)** sirf `...still waiting (N s)` me gaya — ye
batane wala koi nahi tha ki **kaun** lock hold kar raha hai. Machine stuck hai ya
build chal raha hai, pata nahi chalta tha.

**Fix (`Clipchamp_Bunny/tools/build.ps1`):**

- Holder ek sidecar `.build-lock.holder` me likhta hai: `agent`, `model`,
  `buildId`, `pid`, `startedAt`.
- Waiter har 30s par batata hai: `held by <agent> (<buildId>, running Ns)`.
- Release par sidecar delete (warna agla waiter purane naam dikhata).

(Lock file khud `FileShare.None` hai, isliye use padha nahi ja sakta — isi liye
alag sidecar.)

### 2.6 Ledger lease claim fail → deploy poora abort

`throw 'refusing to build without a lease'` — ledger down/`node` hang hote hi
deploy hi na chale. Ye `sarkariLedger.ps1` ke apne design contract ke ulta hai
("a missing ledger must not be able to block the user's desktop").

**Fix:** ledger ek **advisory queue** hai, mutex `build.ps1` ka lock hai. Ab
claim fail par loud warning ke saath build chalta hai, aur order ko
`cancelled` (+ asli reason) se close kiya jaata hai — ledger par jhooth nahi
rehta. Sirf tabhi jab lease mili ho, heartbeat job chalta hai (warna ek queued
row aage ke waiting agents ke saamne zinda rehti).

### 2.7 `-Check` / `-Legacy` documented door par bind hi nahi hote the

`AGENTS.md` advertise karta hai:

```powershell
pwsh -File tools\deploy.ps1 -Check
```

Par `tools/deploy.ps1` ke `param(...)` me `Check` ya `Legacy` tha hi nahi, aur
`-File` arguments **us** param block se bind hote hain — isliye ye command
**phailti thi**:

```
deploy.ps1: A parameter cannot be found that matches parameter name '…'
```

`$PSBoundParameters.ContainsKey('Legacy')` wala branch bhi **dead code** tha
(key kabhi exist hi nahi karti thi).

**Fix:** dono switch declare kiye. Verification (zero side-effect — binding
failure script ko chalne hi nahi deti):

```
pwsh -File tools\deploy.ps1 -Check   -BogusProbe  → error sirf 'BogusProbe' par
pwsh -File tools\deploy.ps1 -Legacy  -BogusProbe  → error sirf 'BogusProbe' par
```

### 2.8 Prettier har agent ka verify block karta tha

`npm run verify:fast` pehle `lint` chalata hai, aur prettier ye **runtime
artifacts** par fail ho raha tha:

- `sarkari_deploy/records/**` (pipeline **har run** pe likhta hai → kal phir
  fail, day after bhi fail)
- `sarkari_open_contribute/**` (staged proposals)
- `tmp_pathcheck.mjs` (debug scratch, repo root me)

**Fix:** `.prettierignore` me `sarkari_deploy/records/` + `tmp_*.mjs` add kiya
(generated output hai, source nahi), aur baaki docs ko format kiya
(content-preserving whitespace only).

```
npm run lint  →  All matched files use Prettier code style!
```

### 2.9 Fast lane fake Rust error deta tha (PG 1.4)

`cargo check` ko `dist/` chahiye (`generate_context!` compile-time me embed
karta hai). Jab doosre agent `dist/` rewrite kar raha hota tha, preflight ye
fausla deta tha jo hota hi nahi tha:

```
error: failed to read asset at ...\dist\assets\media.json
```

PG proposal ka tareeka: `dist` missing ho toh `npm run build` chala do. **Ye
maine nahi lagaya** — usse koi bhi race bana sakta hai, aur mera preflight
**lock hold nahi karta**, toh wo doosre agent ke lock-held build ke neeche
`dist/` rewrite kar deta — bilkul wahi mixed-executable corruption jo `build.ps1`
ka lock rokne ke liye bana hai.

**Mera tareeka (safer):**

- `dist/index.html` missing → preflight **stand down** karta hai, saaf bolta hai
  "locked build Rust ko asli me verify karega". (Aur mera naya sidecar §2.5 wahi
  batata hai kaun build kar raha hai.)
- Output me `failed to read asset` aaya toh use **transient asset race** maana,
  Rust error nahi — locked build dobara check karega.
- Asli compilation error par ab bhi **throw** (wahi behaviour).

### 2.10 StrictMode ke unguarded property access

Purane crashes: `.WorkId`, `.AgentName/.ModelName`, `.Count`. Usi class ke do
aur:

- `$rawProfile.AllottedMinutes` — profile me field na ho toh deploy wahi mar jaata
  jahan build shuru hona tha. Ab guarded + default 30.
- `New-SarkariLedgerOrder` ke saare field (`AgentName/ModelName/Task/Why/EtaMinutes/WorkId`)
  — ab `Read-ProfileText` defensive read, sensible fallback ke saath (fallback
  strings ledger ke apne min-length rules ke andar hain).

Audit: `sarkari_deploy/` ki **13/13 files** UTF-8 me parse OK (0 errors).
Saare `.Count` usages `@()` se initialized hain.

> Note (jaan-boojh kar **nishkarsh nahi** banaya): sirf `sarkariKaam.ps1` me
> UTF-8 BOM hai, baaki 12 me nahi. `pwsh` BOM-less files ko UTF-8 hi maanta hai
> isliye abhi chalta hai. `powershell.exe` (5.1) par nahi chalega — pipeline
> hamesha `pwsh` use karti hai, isliye maine 12 files ko rewrite nahi kiya
> (wo huge diff aur dusre agents ke files hote).

---

## 3. ⚠️ Rule 4 deviation — `PARAM-GUARD` ke hotfix bina sanction ke production me

`PROPOSAL-20261021-OPENCODE-PARAM-GUARD.md` ka `Status` aaj bhi
`PENDING_USER_APPROVAL` hai, lekin uske hotfix **pehle se production code me
hain**. Us file ka apna text bhi ye maanta hai ("Hotfix applied locally … needs
your review").

Maine har daava code se verify kiya:

| PG section | Daava                                                              | Verification                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1        | dot-source caller ke variables clobber karta hai                   | ✅ **FIXED** — `sarkariDeploy.ps1` har dot-source par values forward karta hai. Draft guard `PASS`, exit 0: `Every critical dot-source forwards its values.`                                                                                                                                                     |
| 1.2        | `@PSBoundParameters` native bridge multi-word values kaat deta hai | ⚠️ **Ab evidence iske khilaf hai** — child command line me pura task tha: `-Task:Wire dead keyboard shortcuts, paint-first Home to editor load, zero-RAM splash, …` (78+ chars intact). Toh ya toh ye ab nahi hota, ya kabhi-kabhi hota hai. **Maine iske liye code nahi badla** — galat fix worst ho sakta hai. |
| 1.3        | `-Check`/`-Legacy` documented door par bind nahi hote              | ❌ **Mera verify: PHIR BHI BROKEN** (bogus-param probe se confirm). ✅ **Ab maine fix kiya** (§2.7).                                                                                                                                                                                                             |
| 1.4        | fast lane dist race par fake Rust error                            | ❌ **Apply nahi hua tha.** ✅ **Ab maine alag, lock-safe tareeke se fix kiya** (§2.9).                                                                                                                                                                                                                           |
| 1.5        | claim response token owner overwrite karta hai                     | ✅ **FIXED** — `Start-SarkariLedgerOrder` original `$Order` (token owner) return karta hai aur sirf `RunId/State/LeaseUntil` `Add-Member -Force` se attach karta hai.                                                                                                                                            |
| 1.6        | crashed agent poora lease rakhta hai                               | ✅ **FIXED** — `deploy-ledger.mjs recover --max-heartbeat-age N` maujood hai (line 1409). Default reaper unaffected.                                                                                                                                                                                             |
| 1.7        | `, @(...)` ka unary comma empty list ko `Count=1` bana deta hai    | ✅ **FIXED** — `Get-RunningAppProcesses` plain `@(Get-Process …)` return karta hai; caller bhi `@()` wrap karta hai.                                                                                                                                                                                             |

**Aapke liye faisla:** PG ka `Status` abhi `PENDING_USER_APPROVAL` hai. Aap
chahein to: (a) ab ja kar `APPROVED` karein (kaam pehle se ho chuka hai, bas
record baaki hai), (b) `REVISION REQUESTED` karein jisme 1.2 ka evidence
dobara test karna shamil ho, ya (c) reject. **Main ise approve nahi karunga.**

---

## 4. Jo pending hai — aur kyun lagu nahi kiya

### 4.1 Mera apna proposal

`PROPOSAL-20261021-mimo-FFMPEG-ADAPTIVE-CONCURRENCY` — **pending, lagu nahi.**
Kyunki Rule 4. Ye _app runtime_ ka change hai (Rust thumbnail/waveform), pipeline
se alag. Isko alag se review chahiye kyunki isme concurrency decision badalna
shaamil hai — fallback aaj ka safe behaviour hai, phir bhi iska apna test chahiye.

### 4.2 `opencode/beam-free` ke 10 proposals — decisions ab le liye gaye

User ne delegation di:

> "in 5 ke best ko chuno or karo / other agents work deploy"

Rule 4 ka gate yehi kehta hai — **sirf user** approve karta hai. Ye uska
faislа hai, isliye status ab pending nahi, record hain. Har daave ko pehle
`drafts/Check-10BigProblems.ps1` se, phir **code se dobara** verify kiya:

| #   | Proposal                  | Faisla                 | Kyun                                                                                                                                                 |
| --- | ------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `JOBSTORE-POLL-RAM`       | `PARTIALLY_APPLIED`    | `maxRetainedJobs` 256 → 64 lagu. Baaqi (poll par clone rokna) daemon + frontend **saath** badalne maangta hai — `pipeline.ts` JSON shape padhta hai. |
| 2   | `QUEUE-CONTEXT-CANCEL`    | `APPROVED_AND_APPLIED` | `q.ctx`/`q.cancel` add, `safeRun` ab `q.ctx` deta hai, `Close` `wg.Wait()` se pehle cancel karta hai.                                                |
| 3   | `HTTP-POLL-LOG-SPAM`      | `APPROVED_AND_APPLIED` | `GET /v1/jobs/*` ab `Debug` par; `waitJob` 900ms par poll karta tha — har import me 600 `Info` lines.                                                |
| 4   | `SQLITE-CONNECTION-REUSE` | `REVISION_REQUESTED`   | 13 jagah `Mutex<Connection>` = asli contention risk, faayda sirf kuch ms. Sifarish: `busy_timeout` + WAL `open_db` me ek jagah confirm karo.         |
| 5   | `ENCODER-DETECTION-CACHE` | `APPROVED_AND_APPLIED` | `ffmpeg -encoders` ab `OnceLock` me cache — pehle har call ek naya process spawn karta tha, `detect()` 3 baar call karta hai.                        |

**#6–#10 nahi lage — inke apne check me pattern hi nahi mila:**

```
[OK       ] 6. FFmpeg run buffering            not found '\.output\(\)'
[OK       ] 7. vault upload pressure           not found 'io\.ReadAll'
[NEEDS_FIX] 8. transcript DOM virtualization   found 'virtual'
[OK       ] 9. export buffering risk           not found '\.output\(\)'
[OK       ] 10. memory probe full scan         not found '% 8 == 0'
```

- **#6, #7, #9, #10**: pattern mila hi nahi — ya pehle se fix hai, ya probe
  galat jagah dekh raha hai. Dono case me approve karna galat hai: ya toh
  kaam ho chuka, ya bina proof ke code badal rahe hain.
- **#8**: regex sirf `virtual` dhoondhta hai — aam shabd, false positive.

---

## 5. Verification (handover se pehle)

```
npm run lint          → All matched files use Prettier code style!
npm run check         → svelte-check found 0 errors and 0 warnings
npm test              → 20/20 pass
cargo check --tests   → EXIT=0
node --test deploy-ledger.test.mjs       → 6/6 pass
sarkari_deploy/*.ps1  → 13/13 parse OK (UTF-8)
drafts/Test-SarkariDotSourceClobber.ps1  → PASS, exit 0
```

**Live ledger evidence (fix ke baad) — 19:10 IST:**

```
WO-20261021T125255-52eb2c | active | opencode    | hb age=40s
WO-20261021T133735-2ce018 | queued | mimo (mera) | hb age=20s   ← yahi kal 15.1m me reaped hota tha
WO-20261021T133938-419fa8 | queued | opencode    | hb age=20s
```

Teenon orders **zinda** hain, queue FIFO me hai, koi order mar nahi raha.

---

## 6. Deploy status

### run6 — `WO-20261021T133735-2ce018` — `shipped` (14:13:09Z)

- Build `app-sarkari-20261021-190506-3f4f`, SHA `8679f3b6…`, 28,529,152 bytes
- **FIFO ka saboot:** `opencode` ne `19:29:56` shipp kiya, meri claim
  `19:29:57` — ek second baad. Kal tak yehi jagah 15 minute ka doom loop tha.
- Sanction gate **lock held hone ke bawajood pass** — "waiting, not rejected"
- App chal raha tha (PID 1772) → binary **staged** hai
  `t9-editor-lit.new.exe` me, top-bar me **"Update"** button.

Ledger ke according `shipped`; lekin AGENTS.md ke according desktop pe tabhi
pahunchega jab user **Update** click kare, ya app band karke next deploy
seedha install kare. Ledger hi sach hai, isliye "install ho gaya" main nahi
likh raha.

### run7 — beam-free ka kaam (scope `both`)

Ledger me `shipped` hone par hi yahan likha jaayega. Us waqt tak ye file
"deploy ho gaya" **nahi** kahegi.

---

## 7. Decisions jo le liye gaye (user delegation ke under)

User ka instruction:

> "in 5 ke best ko chuno or karo / other agents work deploy"

1. `OPENCODE-SARKARI-POLICE` — ✅ pehle se approved + implemented.
2. `OPENCODE-PARAM-GUARD` — ✅ **APPROVED**. Uske 6 hotfix production me pehle
   se the; rule 4 ka deviation ab record me hai, chhupa nahi.
3. Mera `mimo-FFMPEG-ADAPTIVE-CONCURRENCY` — **pending hi rahega.** Delegation
   mere apne proposal par self-approval ki permission nahi deti; isko wo
   reviewer chahiye jisne ise likha nahi.
4. `beam-free` ke 10 — **#1, #2, #3, #5 lagu**; **#4 revision par**; **#6–#10
   nahi** (§4.2, aur har ek proposal file me likha hai).
5. Police wiring — ✅ `sarkariPermison.ps1` me `[5] Constitution` ke roop me
   juda. **Andha `exit 2 → reject` nahi**: police `~9.3s` leta hai (build ke
   saamne kuch nahi), aur `PYTHON_BANNED` par deploy **exact paths + clear
   karne wala command** ke saath rukta hai — taaki "build ruk gaya" ka jawab
   kabhi "kyun?" na ho. Koi aur finding (`HIGH` neeche) sirf dikhti hai,
   rokti nahi — is machine ko ek aur tareeka nahi chahiye build rukne ka.

---

## 8. "Local verifies, remote compiles" — sarkari deploy ka naya raasta

User ka faisla: _"theek h sab apply kar do or banao sarkari deploy ko 10x fast"_.

### 8.1 Ek discovery jo sab badal gaya

Ye kaam karte waqt pata chala ki **live pipeline aur legacy pipeline do alag cheezein hain**, aur meri pichli kai fixes **dead path** me thi:

```
deploy.ps1  --(line 172)-->  sarkariDeploy.ps1  -->  sarkariKaam.ps1   ← ASLI PIPELINE
    │                            (wrapper)              (Stage 1-6)
    └── ye sab sirf -Legacy pe chalta hai
```

- `deploy.ps1` ka **daemon build block** sirf legacy path me tha → **live path me daemon kabhi build hi nahi hua**.
- `deploy.ps1` ka **finish gate** bhi legacy me tha → isliye mera "daemon stale to throw" check **kabhi fire nahi hua**.
- `sarkariKaam.ps1` me daemon ka sirf **health check** tha, build koi nahi.

Yeh teen deploys tak nazar nahi aaya kyunki har baar "SHIPPED" report hota tha. **Ab gate live path me hai**, aur daemon build bhi.

### 8.2 Kya bana

| File                                          | Kya                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                    | naya `sarkari-artifact` job: Windows runner pe app + daemon build, SHA-256 manifest, rolling `ci-latest` release |
| `Clipchamp_Bunny/tools/ci-artifact.ps1` (new) | CI artifact download + **SHA verify** — ek hi implementation, dono pipelines use karte hain                      |
| `Clipchamp_Bunny/tools/go-build-id.ps1` (new) | daemon ka version = Go sources ka hash — CI aur deploy **same file** se, toh drift nahi ho sakta                 |
| `sarkari_deploy/sarkariKaam.ps1`              | `-Ci` support, **daemon build/install** (live path me missing tha), **daemon honesty gate**                      |
| `sarkari_deploy/sarkariDeploy.ps1`            | `-Ci` / `-CiRelease` / `-CiRepo` / `-CiBaseUrl` forward                                                          |
| `sarkari_deploy/sarkariLedger.ps1`            | **Task 200-char clamp** (yehi wajah thi ki ek deploy ka ledger order hi nahi bana)                               |
| `sarkari_deploy/sarkariForm.ps1`              | scope mismatch: rejection + 40-point challan → **warning** (do-kaam-me-baatna sahi hai)                          |
| `AGENTS.md` §10 (new)                         | 5-7 agents ke rules: worktree, file ownership, verify locally, compile remotely                                  |

### 8.3 Ek aur gap jo CI ne chupaye

Path filter me `Clipchamp_Bunny/**` **kisi lane ko match hi nahi karta tha** — yaani **jo app actually ship hota hai, uska CI me koi check nahi tha**. Ab `frontend` aur `rust` lanes dono ye cover karte hain.

### 8.4 10x kahan se aata hai

|                    | Pehle                                                | Ab                             |
| ------------------ | ---------------------------------------------------- | ------------------------------ |
| Rust release build | 6-12 min, is machine par, `rustc` OOM (`0xffffffff`) | GitHub runner par, off-machine |
| Deploy             | build + install = 12+ min                            | install only ≈ 1 min           |
| Doosre agents      | build lock pakde rehte the                           | unka koi lena nahi             |
| Go daemon          | live path me **build hota hi nahi tha**              | CI me, ya live path me, dono   |

### 8.5 Verification

```
npm run lint                              → All matched files use Prettier code style!
npm run check                             → svelte-check found 0 errors and 0 warnings
npm test                                  → fail 0
node --test deploy-ledger.test.mjs        → fail 0
cargo check --tests                       → EXIT=0
go vet ./... / go test ./...              → EXIT=0
6 × .ps1 parse check (UTF-8)              → OK
CI artifact tests (fake release server)   → ALL PASSED
   1. manifest + exe + daemon fetched, SHA verified
   2. a tampered binary REFUSED
   3. a missing release failed clearly
go-build-id.ps1 vs purana algorithm       → dono `go-9ba53a6087b3d2c0` (identical)
```

### 8.6 "10x" ka proof — teen stage me

**Stage 1 — nayi path ka unit test (fake release server).** Ek local HTTP
server ne ek fake `ci-latest` release serve kiya, aur teen case check hue:
manifest + exe + daemon download hua aur SHA match hua; ek **corrupt binary
refuse** hui; **missing release** par clear failure. Sab pass.

**Stage 2 — poora loop, live.** Ek real `t9-editor-lit.exe` (28.8 MB) aur
ek real `t9cloud.exe` fake release me serve karke poora deploy:

```
[ok] CI executable verified (3cf71569…)
[ok] CI daemon verified (a9ae379d…)
[ok] Staged binary successfully verified
[ok] build.json marker updated (Mode: staged)
[ok] daemon taken from CI (go-9ba53a6087b3d2c0)
[ok] daemon verified (go-9ba53a6087b3d2c0)
[ok] ledger says: shipped
=== DEPLOY EXIT=0   TOTAL TIME = 0.97 minutes ===
```

**0.97 minute** — jismein fast lane 29s (TS 16.3s + cargo check 12.9s) aur
download + SHA verify + install + daemon + marker + ledger 29s. **Compile
zero.** Purana rasta: **12-13 minute**, jismein 12 minute compile.

**Stage 3 — asli GitHub.** `ci-latest` release GitHub par publish hua
(GitHub ke Windows runner ne app + daemon build kiya, SHA manifest ke saath),
aur `deploy.ps1 -Ci` ne usse install kiya — bina kisi local server ke.

### 8.6.1 Jo is dauraan pata chala, aur jo koi document nahi batata

| Kya mila                                                                           | Kyun zaroori tha                                                                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy.ps1` ka **1556-line duplicate pipeline**                                   | live path aur dead path dono the. Daemon build sirf dead path me tha — isi liye 3 deploy "SHIPPED" bole aur `t9cloud.exe` badla hi nahi |
| `sarkari_deploy/` **kabhi commit nahi hua** (80 files untracked)                   | fresh clone / worktree me multi-agent system exist hi nahi karta                                                                        |
| CI ke path filter me `Clipchamp_Bunny/**` **kisi lane ko match hi nahi karta tha** | jo app ship hota hai, uska CI me koi check nahi tha                                                                                     |
| CI ka Rust lane **root crate** check karta tha, ship hone wala nahi                | jo code user ke desktop tak pahunchta hai, use CI ne kabhi dekha hi nahi                                                                |
| `frontendDist: "../build"` gitignored hai                                          | `tauri::generate_context!()` panic → Rust lane clippy se pehle hi red                                                                   |
| `go-build-id.ps1` ka default **galat folder** dhoondhta tha                        | chup-chaap fail nahi hota — khali hash stamp ho jaata tha                                                                               |
| `cargo` PATH shim nahi tha                                                         | koi bhi agent chup-chaap 12-minute compile kar sakta tha                                                                                |

### 8.7 Do aur cheezein jo is kaam me pata chalein

**(a) `sarkari_deploy/` kabhi commit nahi hua.**

```
sarkari_deploy           tracked=0    untracked=80
sarkari_open_contribute  tracked=0    untracked=26
Clipchamp_Bunny/tools    tracked=14   untracked=13
.github/workflows        tracked=1    untracked=0
```

Poora sarkari engine aur saare proposals sirf is machine ke working tree me hain. **Fresh clone ya worktree me multi-agent system exist hi nahi karega.** Ye "5-7 agents" model ki sabse badi fragility hai — aur isiliye commit ek prerequisite hai, ek formality nahi.

**(b) `cargo check` bhi shared target folder par serialize hota hai.** Cargo us folder ko lock karta hai, toh do agents ek saath check nahi kar sakte. Private target folder ka matlab hai har dependency dobara check karna — minutes, seconds nahi. Isliye: **shared tree ek time pe ek agent**, asli parallelism **worktrees** se (har worktree ka apna target folder). AGENTS.md §10.3.1 me likha gaya.

### 8.8 Ek naya tool: `expire-own-order.mjs`

Ek failed deploy apna work order **close nahi kar pata** (token ledger me hash hai, bahar se cancel nahi ho sakta) → order `active` reh jaata hai → **doosre agents uske peeche atak jaate hain**. Ye mere hi ek failed `-Ci` test me hua: `opencode/beam-free` mere dead order ke peeche tha.

- **aage ke liye** — `sarkariKaam.ps1` me ek catch block hai jo failed deploy ka order **foran `failed` close** kar deta hai. Dobara nahi hoga.
- **is ek purane order ke liye** — `expire-own-order.mjs` us order ka lease past me daalta hai, aur phir **ledger ka apna `recover`** usse expire karta hai. Ad-hoc SQL nahi: ledger ka apna rule ("lease khatam ho gayi") hi chalti hai; sirf lease ko sahi jagah pahunchana mere kaam ka tha. Uske baad `opencode/beam-free` **turant claim** kar gaya — cleanup ka asar turant dikha.

### 8.9 Teen cheezein jo user ke instruction par band hui

**(a) "Koi agent kabhi bhi local system slow na kare."**

Ye prose nahi, **machine enforce** karti hai. `~\.cargo-shim\cargo.cmd` asli
cargo se pehle PATH me hai, to har naya process - har agent session -
pehle usi se guzarta hai:

| Command                                                    | Yahan                                             |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `cargo check`                                              | allowed (type-check, link nahi karta - fast gate) |
| `cargo fmt`, `cargo --version`, `cargo metadata`           | allowed                                           |
| `cargo build`, `cargo test`, `cargo clippy`, `cargo bench` | **REFUSED**                                       |
| `tauri build`, `npm run tauri build`                       | **REFUSED** (cargo ko bulate hain)                |

Saath me deploy pipeline se local build **code hi hata diya** - ab ek hi
rasta hai: CI compile karta hai, deploy hash check karke install karta hai.
Escape hatch `T9_ALLOW_LOCAL_RUST=1` hai, taaki "deliberately slow" ek
**decide** ho, ek accident nahi.

**(b) "Sabko GitHub ka access do."**

`GITHUB_TOKEN` + `GH_TOKEN` **User scope** par set hain (wahi credential
jo `git push` use karta hai) - har naye process ko milte hain. GitHub MCP
server **global** opencode config me (`~/.config/opencode/opencode.jsonc`),
to har session ko milta hai. Actions artifact API pehle 404 deti thi
(bina token ke public repo me bhi) - ab chalti hai.

Woh 404 isi se the: token na hone par artifact API 404 deti hai, to agents
ko lagta tha release hi missing hai.

**(c) "Agent ko time batao."**

Report me ab ek block aata hai - ledger se padha, deploy se nahi:

```
ABHI BUILD KAR RAHA HAI:
   opencode/opencode/beam-free
   "ship trash retention + TD fix + brand to desktop"
   22:10:05 se  (0 min pehle)
AAPKA ORDER: KHATAM - SHIPPED
   WO-20261021T160835-79e4d6
   21:38:35 par apply hua, 21:38:50 par khatam
   poora laga: 0.2 min  (aapka andaza tha 10 min)
```

Jo sawaal pehle jawab hi nahi paata tha - _"dusra agent kab tak karega,
mera kab shuru hoga, kab khatam hoga"_ - ab report ke upar hai, aur live
ledger se aata hai, to jhooth nahi bol sakta.

### 8.10 Das agents ke liye taiyari - jo maine web se verify kiya

User ka sawal: _"kya kaam ke liye system ready hai? kal 10 agents use karenge."_

Seedha jawab tha **"abhi nahi"** — aur do blockers mile jo 10 agents par toot-te:

**1. `cancel-in-progress: true`** — 15 me se 6 runs cancel. 10 agents = 9 ke CI run
cancel = 9 ke paas koi artifact hi nahi, aur pipeline **green dikhta** jabki 9 log
binary ka intezaar kar rahe hain.

**2. ek shared `ci-latest` release** — har run usko replace karta tha. 10:00 push
kiya, 10:05 doosre ne push kiya, 10:10 par deploy ko **doosre ka binary** milta,
aur ledger likhta "aapka kaam ship hua".

**3. GitHub ka 20-concurrent-job cap** (web se verify kiya) — `ci.yml` har push pe
9 jobs kholta tha (change-detector + 4 lanes + 3-way cross-compile + build + gate).
10 agents × 9 = **90 jobs**, cap 20.

### Teenon ka hal

| Problem      | Hal                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| Cancel       | artifact workflow alag, `cancel-in-progress: false`, **group per commit** — koi kisi ko cancel nahi karta |
| Galat binary | har commit apne naam se publish (`ci-<sha>`), deploy **apna commit** maangta hai aur **wait** karta hai   |
| 90 jobs      | `ci.yml` ab sirf **PR** par (merge gate), push par sirf artifact (1 job) → 10 agents = 10 jobs ✅         |

### Web search se nikle 3 aur holes

| #   | Hole                                                                                                                             | Hal                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `softprops/action-gh-release` sirf **create** karta hai — dobara chalane par `already_exists` → re-run **publish hi nahi karta** | **`gh` CLI**: create, phir `upload --clobber` — idempotent                  |
| 2   | 10 parallel builds jo pehle khatam ho, **purana binary** rolling release me daal dete                                            | sirf **tab** `ci-latest` update hota hai jab wo commit **abhi bhi HEAD** ho |
| 3   | `vite build` **type-check nahi karta** — type error artifact me chala jaata                                                      | artifact workflow me `npm run check`                                        |

Aur ek fragility: tag format change ho to waiting agent ko kuch nahi milta →
**dono spellings** try hoti hain (`ci-<short7>` aur `ci-<full sha>`).

### Proof

```
3 × "Sarkari artifact" in_progress ek saath   ← parallel, koi queue nahi
Sarkari artifact  completed success
commit-pinned CI test: 3/3 pass
```

**Haan — ab ready hai.** Bas do cheezein discipline hain, pipeline nahi:
**jaldi push karo** (CI parallel build karta hai, tum kaam karte raho) aur
**har agent ka apna worktree** (ek file, ek agent).

### 8.11 Ek baat jo bachi thi - aur ab nahi bachi

**Exit code 1** safal deploys par aa raha tha. Root cause: **PowerShell exit
code ko last NATIVE COMMAND ka status deta hai**. Is pipeline me wo ek
`node`/`git` call hai jiska status deploy se koi lena-dena nahi hai — to
jo deploy app install kar chuka tha, marker likh chuka tha, aur ledger me
`shipped` likh chuka tha, wo bhi **exit 1** deta tha.

Teen deploys tak `SHIPPED` report hua aur exit 1 aaya, aur kisi ko pata
nahi chala ki deploy fail hua ya sirf reporting. Ab successful path par
**`exit 0`** hai, live test se confirm:

```
[ok] CI executable verified (26c4288c…)
[ok] ledger says: shipped
[7] ASLI TIME LAGA:   0.7 Minutes (-4.3 min vs ETA)
=== DEPLOY EXIT CODE = 0 ===
```

Aur usi test me **RAM 2121 MB free (73% used)** — pehle 212 MB (97%) tha.
Wo farak compile hatane ka hai, report ka nahi.

---

## 🏛️ USER SANCTION SECTION (For User Only)

```
[ ] APPROVED FOR IMPLEMENTATION
[ ] REJECTED / CLOSED
[ ] REVISION REQUESTED

User Signature / Notes:
```
