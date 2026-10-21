# 🏛️ Sarkari Proposal: Adaptive FFmpeg Concurrency Governor (live-RAM aware)

- **Proposal ID:** `PROPOSAL-20261021-mimo-FFMPEG-ADAPTIVE-CONCURRENCY`
- **Author Agent:** `opencode/mimo-v2.6-flash-free`
- **Date Staged:** `2026-10-21`
- **Target Subsystem:** `Rust Backend (src-tauri/src/thumbnail.rs, waveform.rs)`
- **Status:** `PENDING_USER_APPROVAL` (Only the user can change this to `APPROVED`)

---

## 1. Problem Statement / Kyo (Why is this needed?)

Zero-RAM mission (AGENTS.md §1) ke against, media extraction sabse bada RAM spike
lata hai. Current state:

- Thumbnail aur waveform extraction abhi **sequential** chalte hain — kyunki
  `Promise.allSettled` dono ko ek saath chalata tha aur 8 GB i3 par ~200-400 MB
  ka combined spike aata tha.
- Lekin sequential ek **fixed, worst-case** decision hai. Machine RAM kitni free
  hai, ye koi nahi dekh raha.

Evidence from the deploy run on this exact machine:

```
Memory (RAM): 355 MB free / 7846 MB free total (95.5% used)
[!] Critical low RAM (1104 MB free). Restricting Cargo to 1 job to prevent linker crash.
```

Machine ka RAM footprint **runtime me badalta hai** — app khulne par, browser +
IDE ke saath, low-battery power-saver mode me. Ek fixed concurrency number
dono taraf galat hai:

| Situation           | Fixed sequential      | Fixed parallel      |
| :------------------ | :-------------------- | :------------------ |
| RAM free (2 GB+)    | 1× slow (unnecessary) | fast ✅             |
| RAM tight (<500 MB) | safe ✅               | OOM / swap stall ❌ |

**Bottleneck:** decision static hai, resource dynamic hai.

## 2. Proposed Solution & Architecture

Ek chhota, pure-Rust governor jo FFmpeg child process spawn karne se **pehle**
live free-RAM dekhta hai aur concurrency level choose karta hai. Koi naya
daemon nahi — sirf ek helper function.

Logic (sketch):

```
fn pick_concurrency(free_mb: u64) -> u8 {
    match free_mb {
        x if x >= 2048 => 2,   // dono extraction parallel
        x if x >= 900  => 1,   // sequential (current behaviour)
        _              => 1,   // critical: sequential + -threads 1
    }
}
```

Files that will change:

- `src-tauri/src/thumbnail.rs` — `-threads` aur spawn decision ke liye
- `src-tauri/src/waveform.rs` — same
- `src-tauri/src/memory.rs` — `free_physical_mb()` reuse (already exists for the
  RAM meter; no new syscall, no new allocation)

Key constraint: **free-RAM reading FFprobe/FFmpeg spawn se pehle hi lena hai**,
warna reading khud spike ka shikar ho jayegi (measurement perturbs the system).

## 3. Zero-RAM & Resource Impact Analysis

- **Estimated RAM consumption during execution:** ~0. Reading free RAM = one
  `GlobalMemoryStatusEx` call, a single 8-byte struct. No buffering.
- **CPU overhead:** negligible (one syscall per extraction batch, not per frame).
- **Any new background daemon/process?** No. Reuses the existing child-process
  model. FFmpeg stays a hard-killed child process.
- **Regression risk:** if the reading is wrong the fallback is `1` — i.e. exactly
  today's safe behaviour. Fail-safe direction is chosen deliberately.

## 4. Banned Tech Compliance

- [x] Confirmed ZERO Python code.
- [x] Confirmed TypeScript / Rust / Go only. (Pure Rust, no new npm dep.)
- [x] Confirmed Svelte 5 runes & IPC choke-point adhered to. (No frontend change;
      no new `invoke()` surface — it is internal to the Rust side.)

## 5. Verification & Rollback Plan

- Fast-check: `pwsh sarkariDeploy.ps1 -Check` (TS + Svelte + cargo, ~65s)
- Full: `npm run verify:fast`
- Unit test target: `pick_concurrency()` is a pure function — table-driven test
  for the 3 branches, same style as `src/lib/shortcuts.test.ts`.
- **If this breaks:** `t9-editor-lit.prev.exe` restore (canary rollback already
  built into `sarkariKaam.ps1`). Because the fallback branch equals current
  behaviour, worst case is "no improvement", not "worse than before".

---

## 🏛️ USER SANCTION SECTION (For User Only)

```
[ ] APPROVED FOR IMPLEMENTATION
[ ] REJECTED / CLOSED
[ ] REVISION REQUESTED

User Signature / Notes:
```

---

**Decision (2026-10-21, user-sanctioned delegation).** The user wrote:

> "in 5 ke best ko chuno or karo / other agents work deploy"

The user is the only approver (CONTRIBUTING_RULES rule 4); this records the
user's choice of the best option for each of the five open decisions rather
than an agent approving its own work. Where a self-approval would have been
required, the proposal stays pending and says so.

---

### The author declined to decide this one

This proposal is `mimo-v2.6-flash`'s own work. Rule 4 exists so that no agent
sets its own status, and a delegation to "pick the best of the five" does not
lift that for the delegator's own file - it would make the gate decorative.
It stays `PENDING_USER_APPROVAL` and needs a reviewer who did not write it.
