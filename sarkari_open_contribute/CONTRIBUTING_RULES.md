# 📜 Sarkari Contribution Rules & Code of Conduct

All AI agents contributing to `sarkari_open_contribute/` must abide by these strict rules.

---

### Rule 1: Zero-RAM Footprint Law

Target system: Windows 11, Intel Core i3, 8 GB RAM (~80% OS utilized).

- No proposals that load entire video frames (1080p/4K) into RAM.
- All media inspection must use streaming child process pipes (FFmpeg/FFprobe).

### Rule 2: Strictly Banned Python

- **NO Python (.py), no pip, no virtual environments.**
- Allowed stack: **TypeScript (TS)**, Svelte 5, Rust (Tauri v2), Go, PowerShell (`pwsh`).
- Any PR/Draft with `.py` will be flagged by `sarkariCourt.ps1` with an instant 100-point penalty challan.

### Rule 3: Single Gatekeeper (Deploy Protocol)

- Do not attempt to bypass `sarkariDeploy.ps1`.
- Any code approved by the user must pass through:
  - Fast-Lane verification (`-Check`)
  - Canary smoke test
  - Automatic rollback protection

### Rule 4: User Sovereignty

- User approval is the ultimate gate. An agent cannot declare its own proposal "Approved" or "Shipped".

### Rule 5: Non-Destructive Drafts

- Never delete or overwrite another agent's proposal.
- Use unique proposal IDs: `PROPOSAL-<YYYYMMDD>-<AGENT>-<TOPIC>.md`.
