# Changelog

All notable changes to T9 Editor LIT are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version itself lives in `tauri.conf.json` — it is read, never written.
This file explains what changed between releases.

## [Unreleased]

## [0.2.0] - 2026-10-21

The release that moved the compile off the machine that runs the app.

On an 8 GB i3 with about 1 GB of free RAM, a Tauri release build takes six to
twelve minutes, holds the build lock that every other agent is waiting
behind, and ends in `rustc exited 0xffffffff` when the linker runs out of
memory. It was the single biggest reason agents stalled each other here.

From this release the compile happens on GitHub's runner, and the machine that
runs the app only verifies a hash and installs. A full deploy takes under a
minute.

### Added

- **CI builds the artifact.** A dedicated workflow builds the Windows app and
  the Go daemon on GitHub's runner, hashes both, and publishes them with a
  manifest. Each commit gets its own release, so a build is a fact rather than
  a pointer that moves.
- **A deploy installs its own commit's build.** `deploy.ps1 -Ci` asks for the
  artifact of the commit it was given and waits for it if CI has not built it
  yet. It never installs another agent's binary and records it as its own.
- **`sarkariShip.ps1`** — one command for the whole chain: verify, commit,
  rebase, push, deploy.
- **The report says what is happening now.** Every deploy prints who is
  building, when your work starts, when it lands, and when it is done.
- **The Go daemon is built by the deploy.** It was missing from the live path
  entirely, so three deploys in a row reported `shipped` while `t9cloud.exe`
  stayed exactly as it was.
- **GitHub access for every agent** — a token in the environment and the
  GitHub MCP server in the global config.

### Changed

- **The compile does not happen on this machine.** A `cargo` shim ahead of the
  real cargo refuses `build`, `test`, `clippy` and `bench`. `cargo check` and
  `cargo fmt` still work, because type-checking without linking is cheap and
  is the local gate.
- **The deploy pipeline is one pipeline.** `deploy.ps1` used to carry a second
  copy of the whole thing — 1556 lines that nothing ran. Two copies of one
  pipeline is how the daemon build went missing for three deploys.
- **The scope check warns instead of refusing.** Splitting a change into an
  app order and a daemon order is correct engineering, and a gate that
  punished it was teaching agents to declare a scope the record could not
  back up.
- **A failed deploy closes its own work order.** It used to leave the order
  `active`, and every agent behind it waited for a lease nobody would release.

### Fixed

- A task longer than the ledger's 200 characters produced **no work order at
  all**, and the build then ran with no lease while the record stayed empty.
- The Update button could offer a **stale build**, rolling the user's app
  backwards, because an earlier staged copy was never cleared.
- A successful deploy exited **1**, because PowerShell exits with the status
  of the last native command it ran.
- The CI Rust lane failed before it compiled anything: the app's
  `frontendDist` points at a directory that only exists after a frontend
  build, and the macro that reads it panics when it is not there.
- The path filter matched **none** of the app that actually ships, so the
  shipped code had no CI check at all.
- The daemon's version was a hash of the Go sources, computed from a path
  that does not exist — which does not fail loudly, it stamps an empty
  version.

### Known limits

- Ten agents share one working tree. Two agents editing the same component
  will merge badly, so each agent should use a worktree.
- Ten agents in one session is a lot of memory. The pipeline serves ten; the
  machine serves three or four comfortably.

[Unreleased]: https://github.com/engrtarun/T9EditorLIT/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/engrtarun/T9EditorLIT/releases/tag/v0.2.0
