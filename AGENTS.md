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
│ t9cloud Go daemon (127.0.0.1:7878)           │  Groq Whisper, Gemini flags, Telegram MTProto
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

---

## 6. Desktop App Ko Deliver Karna (DONO agents ke liye)

Repo me **do agents** kaam karte hain — app/UI (`Clipchamp_Bunny/`) aur Go
daemon (`go/`). User desktop app **taskbar se** chalata hai, isliye koi bhi
kaam tabhi tak dikhega nahi jab tak wo **install** nahi hota.

**Ek hi darwaza hai — `Clipchamp_Bunny\tools\deploy.ps1`.** Poora contract,
form fields, queue rules, exit codes aur troubleshooting:
[`docs/AGENT_DEPLOY_PROTOCOL.md`](docs/AGENT_DEPLOY_PROTOCOL.md).

Har deploy pehle **SQLite ledger** me ek work order banata hai:

| Field    | Switch        | Kya                                          |
| -------- | ------------- | -------------------------------------------- |
| Agent    | `-Agent`      | kaun deploy kar raha hai                     |
| Model    | `-Model`      | exact `provider/model` id                    |
| Task     | `-Task`       | kya change ho raha hai                       |
| Why      | `-Why`        | kyun zaroori hai                             |
| ETA      | `-EtaMinutes` | build + install + verify ka honest estimate  |
| Scope    | `-Scope`      | `app` · `go` · `both` · `docs`               |
| Priority | `-Priority`   | 0–100 (default 50; >60 ke liye `-Emergency`) |

```powershell
cd Clipchamp_Bunny
pwsh -File tools\deploy.ps1 -Interactive     # form, phir build
pwsh -File tools\deploy.ps1 -Status          # ledger: active + queue
pwsh -File tools\deploy.ps1 -Doctor          # installed state check
```

Ya repo root se double-click: `Deploy-T9EditorLIT.bat`.

Ye script khud ye sab karti hai:

| Step    | Kya                                                                      |
| ------- | ------------------------------------------------------------------------ |
| ledger  | work order + fair queue (one active, FIFO, priority aging)               |
| build   | `build.ps1` → frontend + `npx tauri build --no-bundle`, SHA-256 manifest |
| daemon  | `go/` sources naye hon to rebuild + restart/stage `t9cloud`              |
| install | `%LOCALAPPDATA%\Programs\T9EditorLIT\` — app + daemon + `.env`           |
| stage   | app chal raha ho to `t9-editor-lit.new.exe` / `t9cloud.new.exe`          |
| verify  | hashes, `build.json`, `/healthz`, no repo-exe instances                  |
| pin     | Start menu shortcut + AppUserModelID + taskbar pin                       |

**Running app me update:** app chal raha ho to naya build stage hota hai aur
top bar me chhota **"Update"** button aata hai (sirf staged exe hone par).
User click karta hai → helper app + daemon swap karke restart karta hai.
App band ho to build seedha install hota hai; button ki zaroorat nahi.

**Ledger hi sach hai:** `shipped` ke bina desktop pe change nahi pahuncha.
"Build chal raha hai" tabhi bolo jab `deploy.ps1 -Status` me `ACTIVE` ho.
"Baad me bata dunga" completion nahi hai — `shipped`, `failed`, ya
`cancelled` me se ek close karo.

> **Go side ke liye (doosra agent):** apna kaam commit kar do — bas. Daemon
> rebuild aur install `deploy.ps1` khud kar deta hai. Tumhe alag se
> `go build` ya `t9cloud` restart nahi karna. Bas `-Scope go` (ya `both`)
> ke saath deploy chalao.

> **Sarkari Deploy & Fast-Lane Accelerator:**
> Ab `deploy.ps1` aur `Deploy-T9EditorLIT.bat` automatically naye **Sarkari High-Speed Engine (`sarkari_deploy/`)** se wired hain:
>
> - **10-Second Fast-Check:** `pwsh -File tools\deploy.ps1 -Check` (TypeScript + Svelte + Rust syntax check in seconds).
> - **Live 4-Min Pulse:** Execution ke dauran har 4 minute me live progress pulse report aati hai.
> - **Canary Auto-Rollback:** Binary startup par panic kare toh 2 second me `.prev.exe` restore ho jata hai.

---

## 7. Branding — the board is the source of truth

**Source of truth:** `Clipchamp_Bunny/T9 Editor LIT Branding Board.png`
(colour palette, primary logo, app icon, and the DO / DON'T rules).

| Rule                                           | Why                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The brand mark is **traced**, never hand-drawn | The board's logo is a _sculpted_ mark. `tools/branding/trace-mark.mjs` reads the original pixels and writes `src/lib/components/dashboard/BrandMark.svelte`. The script's own quality gate (the trace must match the source artwork pixel for pixel) fails the build if the trace drifts. |
| **Never hand-edit** `BrandMark.svelte`         | It is generated. Re-run `node tools/branding/trace-mark.mjs` instead.                                                                                                                                                                                                                     |
| Colours come from the board                    | `#4D8DFF` primary blue, `#F5F7FA` text, `#15171B` background. The token is `nc-brand`; `nc-gold` is only a legacy alias.                                                                                                                                                                  |
| Icons come from the board                      | `npx tauri icon tools/branding/app-icon.png` regenerates the whole set.                                                                                                                                                                                                                   |
| No other product's name in the UI              | "Nanami Cut" and "Clipchamp" are gone from anything the user can see. Clipchamp may be mentioned in _code comments_ that explain where a measurement came from.                                                                                                                           |
| The version number is read, not written        | `tauri.conf.json` is the only place the version lives; the UI asks the binary.                                                                                                                                                                                                            |
| No fake "7" or letter stand-ins for the logo   | The mark is the mark, in every surface.                                                                                                                                                                                                                                                   |

---

## 8. The dev server (localhost) is a shared tool — do not break it

The UI is edited on **localhost:5174** (`cd Clipchamp_Bunny; npm run dev`).
The user opens it in a browser with Inspect Element, changes the UI there, and
the desktop app is the _shipped_ copy of the same frontend.

**The dummy data is a shared fixture. Do not break it.**

| Fixture                                                | What it is                             | Rule                                                                                                                                    |
| ------------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `public/assets/clipchamp_OBSrecord.mp4`                | the real OBS recording the demo uses   | never delete or move it                                                                                                                 |
| `public/assets/media.json`                             | its probe result                       | `url` must be the file's **real** public path (`/assets/...`) - a hand-written path 404'd once and the preview stage was silently empty |
| `public/assets/waveform.json`, `public/assets/thumbs/` | the real waveform and filmstrip        | regenerate with `node tools\generate-media.mjs`, never by hand                                                                          |
| `src/lib/mock.ts`                                      | the mock transcript + `DUMMY_PROJECTS` | the browser has no SQLite, so these are what the dashboard shows                                                                        |

**What the browser mode gives you:** the dashboard with a full grid of dummy
projects (real baked frames as posters), and the editor with the real video,
the real waveform, the real filmstrip and a mock transcript scaled to the real
duration. Enough to change any UI with Inspect Element.

**Do not:**

- **Do not leave the dev server broken.** A blank page on localhost is the
  single most common way an agent "finishes" without the change ever being
  seen. If you edited a `.svelte` file, reload and confirm the page still
  renders.
- **Do not fight another agent over the same file.** Two edits to one
  component merge badly: a stray `</div>` in `HomeDashboard.svelte` blanked the
  whole page. After any edit to a file another agent is also touching, run
  `npm run check` **and** load the page.
- **Do not watch the Rust build folder.** `vite.config.ts` ignores
  `src-tauri/target`; a build holds `.build-lock` open, the watcher could not
  read it, and chokidar took the whole dev server down. That happened while
  another agent was building.
- **Do not delete `public/assets/` to "clean up"** - it is the demo media.

**A change on localhost is not shipped.** The dev server serves `src/`; the
desktop app runs the frontend **baked into the executable** by
`npx tauri build`. Only a deploy moves a UI change to the user's desktop.

---

## 9. How a deploy proves it reached the app (and not just localhost)

The two are never confused, and the ledger records which one happened:

```text
src/ ──npm run build──> dist/ ──tauri build──> t9-editor-lit.exe  (dist baked in)
                                                         │
                    SHA-256 manifest ◀──────────────────┘
                         │
              install to %LOCALAPPDATA%\Programs\T9EditorLIT\
                         │
                    build.json marker  (buildId + appSha256)
                         │
              the running app reads it AND compares with the build id
              compiled into its own binary
```

| Check             | Where                                            | What it proves                                                                                                                                                     |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The manifest      | `deploy\builds\<buildId>.json`                   | the exact exe that was built, with its SHA-256                                                                                                                     |
| The install       | `deploy.ps1` / `sarkariKaam.ps1`                 | the installed file's SHA-256 equals the manifest's                                                                                                                 |
| The marker        | `%LOCALAPPDATA%\Programs\T9EditorLIT\build.json` | which build is installed, and its hash                                                                                                                             |
| The running app   | `installed_build()` (Rust)                       | the app reports the **compiled-in** build id (`build.rs` bakes `T9_BUILD_ID` in) next to the marker's - if they differ, the running app is not the installed build |
| The Update button | `updateReady`                                    | true only when `t9-editor-lit.new.exe` exists, so the button means "a newer build is staged", not "the marker changed"                                             |
| After the click   | `normalize_installed_marker()`                   | the app rewrites `mode: staged` to `mode: installed`, so the marker never lies about what is running                                                               |
| Doctor            | `deploy.ps1 -Doctor`                             | exe present, hash == marker hash, marker build == manifest build, no foreign (repo) app instance, daemon `/healthz` version                                        |

**Staged vs live:** if the app was running during the deploy, the new binary is
staged as `t9-editor-lit.new.exe` and the ledger records `mode: staged`. The
user has to click **Update** for it to become live. Say so - a staged deploy
is not on the desktop yet.

**Localhost is never part of this.** `npm run dev` is a development server;
it is not evidence of anything shipping. The evidence is the marker, the
hashes and the doctor.

---

## 10. Five to seven agents at once — local verifies, remote compiles

### 10.1 The rule

> **Your machine verifies. GitHub compiles.**

`cargo build --release` on the i3 is the single biggest reason agents stall
each other:

|                                      | Before                                       | After                                      |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------ |
| Where the Rust release build happens | on the i3 that runs the app                  | on GitHub's Windows runner (7 GB, own CPU) |
| How long it takes                    | 6-12 minutes, often twice                    | ~1 minute of install                       |
| What it does to other agents         | holds the build lock the whole time          | nothing - it never reaches their machine   |
| How it ends                          | `rustc` exits `0xffffffff` when RAM runs out | green or red, off-machine                  |
| Go daemon                            | built locally too                            | built in the same CI job                   |

The build lock still exists, and it still matters - it serialises the
_install_, so two agents can never write the executable at the same time.
What moved is the compile.

### 10.2 What an agent runs

**One command does all of it:**

```powershell
pwsh -File tools\sarkariShip.ps1 `
    -Agent "opencode/beam-free" -Model "opencode/beam-free" `
    -Task "add the thumbnail menu action" `
    -Why "the card menu had no thumbnail action at all" -Scope app
```

It verifies, commits, rebases, pushes, and deploys - in that order, and it
passes the commit it pushed to the deploy, so the deploy waits for that
commit's artifact instead of installing somebody else's build.

**Or the four steps by hand:**

```powershell
# LOCAL - cheap, no linker, never OOMs. This is your gate.
npm run verify:fast

# REMOTE - the compile, on GitHub, in parallel with other agents.
git add -A; git commit -m "..."; git push

# LOCAL - install what CI built, instead of compiling here.
pwsh -File tools\deploy.ps1 -Ci -Agent "<you>" -Model "<provider/model>" -Task "..." -Why "..." -Scope app
```

`deploy.ps1 -Ci` downloads the artifact from the rolling `ci-latest`
release, checks its SHA-256 against CI's own manifest, and then goes through
the **same** pipeline a local build does: ledger work order, build lock,
canary, marker, doctor. Only the compiler moved; the contract did not.

**A note on the shared tree.** `sarkariShip.ps1` commits _everything_ in
the tree by default, because the tree is shared and a half-commit is not a
thing git can do. That has always been how this repository behaved - and
it is how another agent's work ends up in your commit. If you want only
yours: `-Paths Clipchamp_Bunny/src/lib/components/...`.

### 10.2.1 If you are one of several agents

This is the part that matters when ten agents share one repository.

**Your deploy installs YOUR commit's build. It waits for it.**

```text
you push          →  CI queues your build (it does NOT cancel other
                      agents' builds - that is the whole point of the
                      separate artifact workflow)
you deploy -Ci    →  the deploy asks for ci-<your commit>
                   →  if CI has not published it yet, the deploy WAITS
                      (up to 12 minutes) instead of installing somebody
                      else's build
```

Without that, the rolling release moves under you: you push at 10:00,
somebody else pushes at 10:05, and at 10:10 a plain "install the newest
build" hands you _their_ binary while the ledger records that your work
shipped. So:

| Situation                                                  | What happens            |
| ---------------------------------------------------------- | ----------------------- |
| Your commit's build is not published yet                   | the deploy waits for it |
| The rolling release holds a different commit               | it is not used          |
| A release named after your commit holds a different commit | refused                 |
| You want a specific commit                                 | `-ExpectCommit <sha>`   |

**Push early.** The wait is not wasted time - you are working while CI
builds. Pushing at the last minute means waiting at the last minute.

**One shared tree is still one shared tree.** Two agents editing the same
`.svelte` will merge badly (§8). A worktree per agent is the answer
(§10.3).

`-Ci` tells you when the binary is not what you think it is:

- the CI build is from a different commit than your HEAD
- your working tree is dirty (CI builds from a commit, so local edits are
  **not** in the binary)

Both are warnings, not failures - but read them. A `-Ci` deploy installs a
**commit**, not your working tree.

### 10.3 Working with other agents

The repository has one working tree, and 5-7 agents editing it at once is
how two edits land in one component and blank the page.

| Rule                                                                                          | Why                                                                                                                     |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **One file, one agent.** If someone else is in a file, do not edit it.                        | Two edits to one `.svelte` merge badly. A stray `</div>` in `HomeDashboard.svelte` blanked the whole page.              |
| **Own your lane.** Split by area (dashboard / editor / daemon / pipeline), not by file count. | Ownership that follows a feature survives a change better than ownership that follows a directory listing.              |
| **Use a worktree** for anything bigger than a fix.                                            | `opencode worktree_create <name>` gives you a tree of your own. No collisions, and the merge is a normal git operation. |
| **Commit before you deploy.**                                                                 | CI builds from a commit. An uncommitted change is not in any artifact, ever.                                            |
| **Never touch the shared fixtures** (§8).                                                     | `public/assets/*` and `src/lib/mock.ts` are the demo. Breaking them breaks every other agent's preview too.             |
| **Do not run `cargo build` locally.**                                                         | You will OOM and you will hold the lock. `cargo check` is enough to know your code compiles.                            |

### 10.3.1 The target folder is a lock too

Even `cargo check` serialises on the shared
`Clipchamp_Bunny/src-tauri/target` folder - cargo locks it, so two agents
checking at the same time take turns. That is worth it: a private target
folder means re-checking every dependency, which is minutes instead of
seconds.

So the rule is: **the shared tree is for one agent at a time**, and real
parallelism comes from **worktrees**, each of which gets its own target
folder. That is the difference between "five agents taking turns" and "five
agents working".

A `-Ci` deploy still runs the local fast lane (`cargo check`), because the
machine verifies before it installs. That check is seconds to a minute and it
is worth it - but it is also the one local step where two agents can still
collide.

### 10.4 The contract does not move

Everything in §9 still holds for a CI build, because CI stamps the same
identity:

- `T9_BUILD_ID` is compiled into the binary by `build.rs`, and CI sets it
  to the same `buildId` the manifest carries - so the marker and the
  compiled-in id agree and `installed_build()` is honest.
- The manifest carries the SHA-256 of both binaries. `deploy.ps1` refuses
  to install a binary whose hash is not the one CI published.
- The Go daemon's version is a hash of the Go sources, computed by
  `tools/go-build-id.ps1`. `deploy.ps1` dot-sources that same file, so CI
  and the deploy cannot disagree about what "the current daemon" is. A
  `go`/`both` work order refuses to be recorded as shipped unless the
  installed daemon carries the version that work order intended to install.
- Canary, staged vs live, the Update button, `-Doctor`: all unchanged.

### 10.5 There is no local build to fall back to

That used to be here: "if CI is down, `deploy.ps1` without `-Ci` still compiles
locally". It is gone, and it is gone on purpose.

A local release build on this box takes six to twelve minutes, holds the
build lock that every other agent is waiting behind, and dies in the linker
for want of memory. Keeping it as a "fallback" meant it was not a fallback -
it was the path that everybody fell back **to** the first time anything went
wrong, and every one of those times cost the whole queue.

So there is one path now. If CI is down or red:

1. **push** - the compile is CI's job, and it is free for you
2. **watch the run** - `AGENTS.md` §12 has the three-line recipe
3. **deploy** - `deploy.ps1 -Ci` installs the `ci-latest` artifact

If the run is red, the deploy says so and installs nothing. That is the
correct outcome: a red CI run means the code does not compile, and shipping
it anyway would be the bug.

---

## 11. The Rust compile does not happen on this machine

**This is a hard rule, and it is enforced by the machine, not by good
intentions.**

### The rule

> **No agent runs a Rust compile on this box.**
> `cargo build`, `cargo test`, `cargo clippy`, `cargo bench`, `tauri build` -
> all of them are refused. The compile happens in CI, on GitHub's runner.

### Why it is a rule and not a preference

This is an 8 GB i3 with roughly **1 GB of free RAM**. A Tauri release build
here:

- takes **6-12 minutes** (often twice, because the first attempt dies),
- holds the **build lock** that every other agent is waiting behind,
- and ends in **`rustc exited 0xffffffff`** - the linker killed for want of
  memory.

It is the single biggest reason agents stall each other in this repository.
Five agents working at once is not possible while one of them is compiling.

### How it is enforced

`%USERPROFILE%\.cargo-shim\cargo.cmd` sits ahead of the real cargo in the
PATH, so **every** process - every agent session, every shell - meets it
before cargo does. It refuses the compiling subcommands and prints this:

```
  RUST COMPILE IS NOT ALLOWED ON THIS MACHINE
```

and it lets the cheap ones through:

| Command                                           | Allowed here? | Why                                               |
| ------------------------------------------------- | ------------- | ------------------------------------------------- |
| `cargo check`                                     | **yes**       | type-checks without linking - the fast local gate |
| `cargo fmt`                                       | **yes**       | formatting                                        |
| `cargo metadata`, `cargo tree`, `cargo --version` | **yes**       | inspection                                        |
| `cargo build`                                     | **no**        | 6-12 min, OOM-prone, holds the lock               |
| `cargo test`                                      | **no**        | compiles test binaries                            |
| `cargo clippy`                                    | **no**        | compiles                                          |
| `cargo bench`                                     | **no**        | compiles                                          |
| `tauri build`, `npm run tauri build`              | **no**        | they call cargo                                   |

### The escape hatch

`T9_ALLOW_LOCAL_RUST=1` lets **one** command through. It exists so that
being deliberately slow is a decision somebody makes on purpose, with the
cost written down - not an accident that happens in a hurry.

```
T9_ALLOW_LOCAL_RUST=1 cargo build --release
```

### What to do instead

```powershell
# 1. the fast local gate - type-checks, does not link
npm run verify:fast

# 2. hand the compile to CI
git commit -am "..." ; git push

# 3. install what CI built
pwsh -File tools\deploy.ps1 -Ci -Agent "<you>" -Model "<provider/model>" `
     -Task "..." -Why "..." -Scope app
```

CI publishes a rolling `ci-latest` release with the app, the daemon and a
SHA-256 manifest. The deploy downloads it, checks the hash, and installs -
**without compiling anything here**. A full deploy takes **under a minute**,
and while it runs, the lane is free for the next agent.

### Why the local build path was deleted

It was not removed to be tidy. `deploy.ps1` used to carry a **second copy**
of the whole deploy pipeline - 1556 lines that compiled the release here.
Two copies of one pipeline is how the Go daemon went missing for three
deploys in a row: the live path never had a daemon build in it, and the copy
nobody ran was the one that did. The classic pipeline is gone; the compile
lives in CI, where it belongs.

---

## 12. GitHub access is already there - use it

Every agent on this machine already has GitHub access. You do not need to
ask, and you do not need to install anything.

| What                       | Where it comes from                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `git push`                 | Git Credential Manager, already configured                                          |
| `GITHUB_TOKEN`, `GH_TOKEN` | the same credential, exported at **User** scope - every new process inherits it     |
| GitHub MCP server          | `~/.config/opencode/opencode.jsonc`, **global** - every session gets it             |
| Actions artifact API       | works with the token (without it, the API answers 404 even for a public repository) |
| `gh` CLI                   | **not installed** - the API and `git` cover everything the pipeline needs           |

### Reading a CI run

```powershell
$h = @{ 'User-Agent' = 't9'; 'Authorization' = "Bearer $env:GITHUB_TOKEN" }
$run = (Invoke-RestMethod -Uri 'https://api.github.com/repos/engrtarun/T9EditorLIT/actions/runs?per_page=1' -Headers $h).workflow_runs[0]
$run.status; $run.conclusion; $run.html_url
```

### The artifact CI publishes

CI keeps a rolling release called **`ci-latest`** with three assets:

| Asset                   | What it is                                       |
| ----------------------- | ------------------------------------------------ |
| `t9-editor-lit.exe`     | the app, built on GitHub's runner                |
| `t9cloud.exe`           | the daemon, stamped with the Go source hash      |
| `sarkari-manifest.json` | the SHA-256 of both, the build id and the commit |

`deploy.ps1 -Ci` downloads exactly these, checks the hashes against the
manifest, and installs. **No token is needed for that** - the release assets
of a public repository download anonymously.

### The MCP server needs a restart

The MCP server appears in **new** opencode sessions. A session that was
already running when it was added keeps its old tool list - restart it.

### If you get a 404

| 404 on                            | Means                       | Do this                                      |
| --------------------------------- | --------------------------- | -------------------------------------------- |
| `releases/download/ci-latest/...` | CI has not published yet    | push, then wait for the run                  |
| `actions/artifacts`               | no token in the environment | the token is at User scope; open a new shell |
| `actions/runs`                    | same                        | same                                         |
