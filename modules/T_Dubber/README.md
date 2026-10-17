# T_Dubber Reference Submodule

- **Remote URL:** [https://github.com/engrtarun/T_Dubber](https://github.com/engrtarun/T_Dubber)
- **Status:** Un-cloned remote submodule (deliberately not populated locally).

## Purpose for AI Agents

This submodule points to **T_Dubber**, which contains the battle-tested multi-connection Telegram uploader (`tgup`) and MTProto logic.

### ⚠️ IMPORTANT AGENT DIRECTIVE:

1. **DO NOT run `git submodule update --init` locally**:
   The contributor's machine is an i3 with 8 GB RAM. Cloning `T_Dubber` locally would pull heavy AI models, image assets, and Python dependencies onto this machine.
2. **PYTHON IS STRICTLY BANNED in T9EditorLIT**:
   `T_Dubber` has Python Telethon scripts, but **T9EditorLIT forbids Python**.
   All Telegram vault logic taken from `T_Dubber` must be implemented in **Go** (for the `t9cloud` daemon in `go/internal/vault`) or **Rust** (`grammers`), coordinated via **TypeScript**.
3. **Full Reference & Implementation Guide**:
   Read [`../../docs/TELEGRAM_INTEGRATION_T_DUBBER.md`](../../docs/TELEGRAM_INTEGRATION_T_DUBBER.md) for the exact architecture, Bandwidth-Delay Product math, and code extraction guide.
