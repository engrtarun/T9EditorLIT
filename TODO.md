# TODO - Scratch Pad

_Last updated: 2026-11-18_

## 🔴 High Priority

- [ ] Word cut: multi-line text selection cut (abhi ek row ke bahar selection par toolbar hi nahi aata) + duplicate take hint (added: 2026-11-18)
- [x] Word cut: split ki 0.25/0.35/0.5 s floor hatayi - 10 ms tak split, zero-length part drop, hybrid export chhote kept piece ko drop nahi karta (encode karta hai) (done: 2026-11-18)
- [x] Word cut: bottom timeline par sirf selected range ke upar blue band (minimap tick + CUT chip) (done: 2026-11-18)
- [x] Word cut: imported ElevenLabs JSON ke nested words + purane project ka backfill - SHORT6 me 33/35 rows, 441 words exact; 7-1a/7-2a jaan-boojh kar approx (manual splits se text duplicate) (done: 2026-11-18)
- [x] Split key: word selection pending ho to S/Delete global cut/keep na chale - sirf selection Cut (done: 2026-11-18)
- [x] Selection UX: drag ke time transcript virtualization freeze + toolbar anchor stable (screen jitter) (done: 2026-11-18)

- [ ] Browser: architecture decide - per-tab webview vs ek hi webview (added: 2026-11-16)
- [ ] Browser: renderer crash/unresponsive ko log karo + auto-reload (instrument first) (added: 2026-11-16) — auto-reload shipped `22e7e57`, abhi tak koi `process failed` line nahi aayi, isliye open
- [ ] Browser: heavy site load atak jata hai, refresh karna padta hai — asli chain `view -> open` → `set_rect` → **kuch nahi** (koi `show`, koi `refused`): `restoreSession()` ke `stats_kv_get` par mount chain ruk jata thi. Fix `1e1400c` (1.5 s deadline + har stage ka `ui ->` log) install + verify hona baaki (docs/TODO.md §11)
- [ ] Browser: back dabane ke 1 s baad view khud wapas khulta hai (`view -> closed` → `view -> open` → `resume`) — ab `screen -> open|close browser (...)` log line se caller pakda jayega (added: 2026-11-17)
- [ ] Browser: overlay park/restore 15 baar 15 s me (`layout.*Open` flap) — ab `overlay -> park (naam)` line se culprit pata chalega (added: 2026-11-17)
- [x] Browser: shell reload ke baad YouTube page Home ke upar paint hota hai + close par app hang (`Responding=False`) — fix shipped: mount par stale webview sweep (`ffe3ccd`) + media flyout UI-thread deadlock (`94dfbb1`); installed `ci-94dfbb1` par verify (docs/TODO.md §12)
- [x] Browser: pinned YouTube → editor → wapas, video band na ho — `ci-94dfbb1` par `media event … playing` + `pin … true` + `show … resume=Some(true)`, aur user ke manual test me playback chalta raha (docs/TODO.md §12)

## 🟡 Medium Priority

- [ ] Transcript import: DOCX/PDF native picker + restart persistence (added: 2026-11-16)
- [ ] ElevenLabs STT browser flow: upload / record / transcribe / export (added: 2026-11-16)

## 🟢 Nice to Have

## ✅ Done

- [x] Ctrl+Shift+B: open in-built browser + a new tab from any screen (home/editor/browser, incl. page shim) (done: 2026-11-18)
- [x] Word cut: toolbar on selectionchange (no mouseup wait), no APPROX, audio-snapped ms boundaries (wave-snap) (done: 2026-11-18)

- [x] Browser home: bottom-right no-internet animation, no text, size ~330px (dial 660px ka aadha), bottom se chipka hua (done: 2026-11-18)
- [x] Browser se wapas (home/studio) ka visible back button TopBar me (done: 2026-11-18)
- [x] Firefox-style 2-finger horizontal swipe -> previous/next tab (shim wheel + BrowserView window listener + browser-swipe.ts test) (done: 2026-11-18)
- [x] Bookmark/pin app close par bhool jata hai - bookmarks+pins ko SQLite (statsSet/statsGet) me persist karo, session success path me pinned tabs restore karo (done: 2026-11-18)
- [x] Tab chips: home dashboard header + editor studio TopBar me bhi dikhao (gate hatao, DashboardTopBar me mount karo) (done: 2026-11-18)
- [x] Persist per-project UI state (zoom, applied preview, loop, both tracks, snap) in SQLite not localStorage (done: 2026-11-18)
- [x] Remove caption over video, move current line + pin/keep/wrong controls below the video (full text wrap) (done: 2026-11-18)
- [x] Word-level cut: select 'jal ki rani' inside a line -> 3 rows (keep/cut/keep) + 3 timeline clips (done: 2026-11-18)

- [x] Browser: page-shim shortcuts installed build par prove karo — `event key 1 -> pinTab`, `event key 1 -> closeBrowserView` live log me (build `ci-1fbadef`, 2026-11-17)
- [x] Browser: pin/unpin round installed build par — pin → back (`swept all, 1 pinned kept`, page hidden) → wapas (`resume=Some(true)`, memory normal). Commit `1fbadef`, docs/TODO.md §10
- [x] Browser cold start Home par khulta hai, YouTube restore nahi — `4880033`; `Ctrl+Shift+T` se band tab wapas (docs/TODO.md §9)

---

## Notes
