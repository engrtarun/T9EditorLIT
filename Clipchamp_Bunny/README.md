# Nanami Cut — UI Prototype (`Clipchamp_Bunny`)

> Zero-RAM, transcript-first video cutter for long Hinglish coding tutorials.
> **"No Overtime"** — Nanami Kento theme.

Full requirement freeze: [`docs/SPEC.md`](docs/SPEC.md)

---

## Chalane ka tarika

```bash
npm install
npm run dev        # http://localhost:5174
```

Checks:

```bash
npm run check      # svelte-check — 0 errors hona chahiye
npm run lint       # prettier
npm run test       # node --test
```

---

## Ye prototype kya hai (aur kya nahi)

| Aa raha hai ✅ | Baad me (Rust/FFmpeg) ⏳ |
| -------------- | ------------------------ |
| 4-mode zero-RAM shell with `{#key}` destroy | FFmpeg child process audio extract |
| Mode 2 ka poora 7:3 Cut dashboard | Groq Whisper real transcription |
| Virtual-scrolled transcript + ✓/✕ | Gemini fumble detection |
| Phantom Cut preview skipping | SQLite persistence |
| Traffic-light waveform, canvas-drawn | Real FPS thumbnail strip |
| Keyboard flow + auto-advance | Tauri shell + Rust export |
| Overtime counter, undo/redo | Telegram MTProto vault |

Mock transcript `src/lib/mock.ts` me hai — shape wahi hai jo Whisper + Gemini return karenge,
isliye backend wire karna sirf data-source ka kaam hai.

---

## Keyboard

| Key | Kaam |
| --- | ---- |
| `Space` / `K` | play / pause |
| `X` / `Delete` | ✕ cut + **auto-advance** |
| `V` / `Enter` | ✓ keep + **auto-advance** |
| `↑` / `↓` | line jump (preview bhi usi second pe) |
| `J` / `L` | ∓5s seek |
| `←` / `→` | frame step (`Shift` = 1s) |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |

Full video keyboard-only: `↓ X X ↓ V ↓ ↓ X ↓ X V …`

---

## Structure

```
src/
  App.svelte                     mode switch + global shortcut layer
  app.css                        Nanami tokens (@theme) + tie/slash effects
  lib/
    types.ts                     TranscriptLine · KeepState · Mode …
    mock.ts                      39-line Hinglish mock + deterministic waveform
    utils.ts                     fmtTime / fmtShort / fmtHuman / niceStep
    stores/
      mode.svelte.ts             epoch counter → drives {#key} teardown
      project.svelte.ts          lines · cutRanges · undo/redo · skipCuts()
      player.svelte.ts           time / playing / zoom
    components/
      TopBar.svelte              mode chips + Overtime Saved counter
      ModeRail.svelte            3-mode rail
      cut/VideoPreview.svelte    Phantom Cut skip logic
      cut/TranscriptPanel.svelte virtual scroll (30 rows in DOM, any length)
      cut/WaveTimeline.svelte    ruler · wave canvas · fps strip · text lane
      modes/{Ingest,Cut,Polish,Export}Mode.svelte
```

## Bans

Python · Electron · Qt/C++ · React · Tailwind v3 — inme se koi nahi.
Media kabhi RAM me buffer nahi hoga; prototype bhi `<video>` stream karta hai, read nahi.