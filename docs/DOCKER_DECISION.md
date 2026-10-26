# Docker — the decision, on record

> **One line:** Docker never runs on the dev box — CI lints, builds and
> smoke-tests the image; the only real runtime for it is a **remote server**,
> someday.

Date: 2026-10-27 · Owner: repo agents (AGENTS.md §13 is the enforcement
surface — every agent reads it before touching anything)

---

## 1. Why the desktop machine says no

The target machine is an i3 / 8 GB box that already runs ~90%+ RAM in
normal operation (telemetry at deploy time: 234–689 MB free). Docker
Desktop on Windows is a WSL2 VM — `vmmem` sits **~1–2 GB resident** even
idle. That is the single resource this repo is built to protect.

| Concern                    | Today's answer                                | Docker's answer                                   | Verdict         |
| :------------------------- | :-------------------------------------------- | :------------------------------------------------ | :-------------- |
| Desktop app (Tauri)        | native Windows GUI, WebView2                  | GUI apps don't ship in containers at all          | **never**       |
| Windows installer build    | GitHub Actions (`npm run tauri build`)        | Windows images are huge; QEMU adds a slow lane    | **never**       |
| Rust compile               | already CI-only (`cargo-shim` enforces)       | linux images can't produce NSIS installers        | **never**       |
| Media pipeline             | FFmpeg child processes, hard-killed, disk I/O | a VM layer under processes already isolated       | **never**       |
| State / transcripts        | SQLite files on disk, zero heap               | a DB-server container is the anti-pattern here    | **never**       |
| **t9cloud daemon, remote** | exe on this desktop only (`127.0.0.1`)        | the ONE useful runtime — isolated, self-contained | **CI + server** |

FAQ: "wouldn't Docker make the app run on all devices?" — no. The desktop
app is a Windows GUI program; devices don't get it from a container, they
get it from the installer the sarkari pipeline deploys. Docker helps
**servers**, not consumer desktops.

## 2. What exists (and where)

| File                                     | Role                                                                                                                         |
| :--------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| `go/Dockerfile`                          | 2-stage build (`golang:1.23-alpine` → `alpine:3.20`), non-root, healthcheck                                                  |
| `go/.dockerignore`                       | keeps `.env`, sessions, git metadata **out of the build context**                                                            |
| `go/.hadolint.yaml`                      | strict lint config; `error` threshold, every ignore has a reason                                                             |
| `go/compose.yaml`                        | remote-run recipe: loopback-only port, runtime `env_file`, session volume, limits                                            |
| `.github/workflows/sarkari-artifact.yml` | the `docker` job - **the only sanctioned docker execution in the repo** (runs beside the artifact job on every push to main) |

CI deliberately does **not** use Docker for compiling the Go daemon
(`go-build` job: plain `GOOS/GOARCH` cross-compilation, CGO off — the
Dockerfile's own history notes QEMU made that path slower).

## 3. The CI job (lint → build → compose-validate → smoke)

Runs on the ubuntu runner **on every push to main** (this is the workflow
every push already runs), beside the Windows artifact job - so a red lint
can never block the artifact's publication, and the artifact job never
touches docker:

1. **hadolint, strict** — `go/.hadolint.yaml`; a red lint fails the lane and
   the `gate` job passes that red on to branch protection.
2. **build** — `docker build -t t9cloud:ci -f go/Dockerfile go/`
3. **compose validation** — `docker compose -f go/compose.yaml config
--quiet` (config-time only; `required: false` lets it pass without a
   real `.env`)
4. **smoke** — `docker run --rm t9cloud:ci -version`

No image is pushed anywhere: the run is validation. The day a server
actually exists, add a `ghcr.io/engrtarun/t9cloud` publish step here — this
file is where that story starts, still CI-only.

## 4. The rules any visible agent follows

1. **No `docker`/`wsl`/`docker compose` commands on the dev box.** Not even
   "just to test". CI answers the question in ~a minute, for free, without
   touching the RAM the zero-RAM directive protects.
2. **Secrets never enter the image.** `.dockerignore` bans `.env`; compose
   loads it at runtime. Anything that bakes credentials into a layer
   (history, cache, registry) is a finding worth fixing immediately.
3. **Loopback is the law.** The daemon has no authentication. Ports bind
   `127.0.0.1` — in compose, in `docker run`, always. `0.0.0.0` is a bug.
4. **Docker Desktop stays OFF on this box.** If anyone starts it:
   `wsl --shutdown` the moment the job is done, and consider
   `~/.wslconfig`: `[wsl2] memory=1GB processors=2`.
5. **The daemon stays the exe for now.** `t9cloud.exe` ships through the
   sarkari pipeline (`deploy.ps1`) — that is the channel the desktop
   contract is built on; a container is for the future server, not a
   replacement for the local daemon.
