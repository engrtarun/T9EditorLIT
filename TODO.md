# TODO - Scratch Pad

_Last updated: 2026-11-19_

## 🔴 High Priority

- [x] Export me fps drop (60 -> 50/30) kyun - source fps preserve karo (done: 2026-11-19) - root cause: per-piece AAC encode ne har join par ~48ms priming silence + container duration audio-driven hone se video me pts holes (47 gaps / 50.9fps). Fix: v2 pipeline - video pieces seedha MPEG-TS me (90kHz tb = 60fps exact), audio EK filter pass (asplit+atrim+concat), last me mux copy. Real SHORT6 plan (50 pieces) par proof: 4570/4570 frames, 0 gaps, delta 1500 ticks (60fps), audio 76.166667s = video se 1.5ms andar
- [ ] Sequence/canvas export (9:16, 1:1, 4:5, 4:3) abhi purane per-piece audio path par hai - wahan bhi v2 (TS video pieces + ek audio pass) lagao (added: 2026-11-19)
- [x] Export "video join failed (exit -2)" jab output field me sirf filename ho (koi folder nahi) (fixed: 2026-11-19, shipped ci-99bb0fc) - kaaran: work dir `.t9export` relative ban gaya, list me `./.t9export/v0000.ts` gaya, aur ffconcat entry ko **list ke folder** se resolve karta hai -> `.t9export/.t9export/...` missing. Fix: list ki har entry absolute (`absolute_flat`), aur bare filename ab seedha Downloads me resolve hota hai (install folder me nahi). Saath me 0-byte piece (ffmpeg exit 0 par koi frame nahi) ab naam lekar error deta hai, cryptic concat fail nahi. Local proof: old-style list `exit -2`, absolute list `exit 0`
- [x] Export progress ke notifications: app toast + Windows native (Win+A/Win+N) (done: 2026-11-19) - start/done/fail par appNotify (export start, `file · size · duration`, fail reason), toasts ke saath
- [x] Export presets: Fast export vs Quality export (user ko dono chahiye) (done: 2026-11-19) - SPEED·QUALITY row me Fast (hybrid) + Quality (encode + original), purana engine/quality list `Advanced` details me collapse (kuch delete nahi hua)
- [ ] Waveform zoom in/out me wave aage-picche + accuracy badhani hai (added: 2026-11-18)
- [ ] Editor playback me cut feel hota hai - export side fixed by v2 (0 gaps / audio-video 1.5ms) (added: 2026-11-18) - preview side: cut ab har **presented frame** par enforce hota hai (`requestVideoFrameCallback`, pehle `timeupdate` ~4Hz = 250ms tak cut chalta tha) + stale-seek guard (`seekFrom` comparison) + mid-seek updates ignore - seek fight khatam. Baaki: 1080p60 ka 1s-GOP seek khud decoder cost hai (proxy preview alag item)
- [x] Export cut ~0.03s off - exact word se cut alag aata hai (frame/audio drift) (done: 2026-11-19) - encode piece ab previous keyframe par decode karke trim karta hai (`Piece.roll`), aur har piece frame-grid par snap (`n/fps`) - A/V dono ko same length milti hai, sub-frame kept piece kabhi drop nahi hota (floor = 1 frame)

- [ ] Word cut: multi-line text selection cut (abhi ek row ke bahar selection par toolbar hi nahi aata) + duplicate take hint (added: 2026-11-18)
- [x] Tiny rows: trim ka fixed 0.3 s floor proportional (`min(0.3, span/2)`) - trimStart backwards-jagta bug fix, timeline handles + segment trims bhi (done: 2026-11-18)
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

- [x] Ctrl+1..9 tab switching agar tab exist kare (done: `browser-keys.ts` BINDINGS me Ctrl+1..8 = `selectTabN`, Ctrl+9 = last tab; shim table test-enforced)
- [x] Browser header: browser me "Studio" nahi - "Fast / Safe / Light / AI Plus / Secure **Browser**" per-letter rolling reveal (done: 2026-11-19) - `RollingWord.svelte`, har letter apne 11px mask me upar roll karta hai (AE reference), studio me sirf "Studio"
- [x] Firefox F11 fullscreen + settings (done: 2026-11-19) - F11 toggle (Esc bahar), browser toolbar me Home ke bagal button, settings me 2 switch: F11 key on/off + toolbar button on/off (switch wahi se live hide/show karta hai). Tauri `setFullscreen` + dev me Fullscreen API
- [x] Tab chip: sirf icon dikhe, uske upar bg nahi (done: 2026-11-19) - active tab ka `ring-nc-brand/55` + `bg-nc-panel-2` hataya: sirf `ring-nc-line/50`, non-active me `text-nc-mut ring-transparent`
- [x] Silence hide/unhide + cut hide/unhide + display filters (done: 2026-11-19) - eye menu ("Both") me naya **Timeline** block: Cut blocks (red), Silence blocks (grey), Filmstrip (frames; OFF par thumbnail fetch hi nahi hota = low-RAM), AI suggestions (green/amber) — chaaron persisted (`settings`), menu khula rehta hai live toggle ke liye. Hide display-only hai: block apni width/right-click restore rakhta hai, strip ripple nahi hoti; minimap bhi wahi filter follow karta hai (silence ab grey, red nahi)
- [ ] Transcript row/time chip (0:00-0:03) hilta hai (added: 2026-11-18)

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
