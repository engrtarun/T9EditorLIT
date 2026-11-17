# TODO — the work ledger

**Rule:** `shipped` ≠ `fixed`. A row is only `done` when it was observed working
on the **installed** app (`%LOCALAPPDATA%\Programs\T9EditorLIT\`), not on
`localhost:5174`. Every claim below carries its evidence, or says it has none.

Status values: `done` · `shipped-unverified` · `in-progress` · `open` · `blocked`

---

## 1. Browser — pin ke baad freeze / glitch

- **Status:** `shipped-unverified`
- **Commits:** `e08fe33` (pin path no longer calls `SetMemoryUsageTargetLevel`,
  background pages parked + LOW), `ce572a7` (overlay park is visual-only; the pin
  action lives inside the tab context menu, so it used to trim a playing page)
- **Evidence it is *not* proven:** the diag log shows the old build surviving
  11 minutes after `pin 1 -> true`; the 2 s `shutdown` was the Update restart.
  So the original "pin freezes the app" correlation was never established.
- **Needs:** one manual pin → editor → back → unpin round on the installed build,
  with `browser-diag.log` kept.

## 2. Browser — app hang / "not responding" / screen atakna

- **Status:** `open` — **root cause not established**
- **Measured on this machine:** free RAM 247–710 MB of 7846 MB (≈96 % used),
  19 `msedgewebview2` processes ≈ 571–782 MB, one page renderer at 325 MB and
  247 s CPU after ~12 minutes (spinning, never painting).
- **Not handled by the app:** WebView2 `ProcessFailed` / unresponsive events are
  not subscribed to. A dead or spinning renderer therefore looks exactly like a
  frozen app: the child HWND keeps its last frame, and every shortcut that lives
  in the page shim is dead with it.
- **Candidate fix (unproven):** subscribe to `ProcessFailed`, log it, and offer
  (or perform) a reload of that one tab — turning "refresh karna padta hai" into
  an automatic, recorded recovery.

## 3. Browser — page adhoora load hota hai, refresh karna padta hai

- **Status:** `open`
- **Evidence:** `event page finished` is logged, yet the visible page can still be
  a spinner on a black video area. That means "finished" is not the same as
  "painted", and nothing checks the difference.
- **Not yet ruled out:** renderer crash (see §2), uBlock extension interfering
  with a media page, and the 1×1 park/restore resize racing the first paint.

## 4. Browser — sab kuch slow

- **Status:** `open`
- **Measured:** every tab is its own WebView2 with its own Chromium renderer.
  A YouTube tab alone is ~325 MB. Nine tabs is more than this box has.
- **Design question (needs a decision):** keep one native webview per tab
  (resume is instant, RAM is linear and unaffordable here) **or** one webview for
  the whole browser with tabs as URL + history (constant ~200 MB, reload on
  switch, no cross-webview z-order class of bugs at all).

## 5. Browser — Firefox-style shortcuts

- **Status:** `shipped-unverified` for the page half, `done` for the app half
- **Evidence (done):** `Ctrl+F` with focus in the app chrome opens the app's Find
  box — observed.
- **Evidence (code):** the page shim's 50-row table is parsed and compared with
  `browser-keys.ts` `BINDINGS` by `browser-shim-keys.test.ts`; `npm test` 182
  passing.
- **Missing evidence:** any `event key <id> -> <action>` line from the current
  build. The page half has not been seen working since the shim rewrite; the last
  logged key events are from older builds.

## 6. Transcript import — Text / PDF / DOCX / JSON / HTML / SRT / VTT

- **Status:** `shipped-unverified` (in real use, visibly working)
- **Commit:** `c017937`, installed as `ci-c017937`.
- Behaviour: SRT/VTT/JSON keep exact timings; Text/PDF/DOCX/HTML become
  word-count estimates and are labelled as estimates in the UI.
- **Not formally tested:** DOCX + PDF through the native file picker, and
  persistence across an app restart.

## 7. ElevenLabs STT — 9-dots launcher + browser flow

- **Status:** `open` — reported broken by the user, not reproduced in a log yet
- **Covers:** upload / record / transcribe / export inside the in-app browser,
  and the blob-download handoff into the import card.

## 8. Verify on the installed desktop app

- **Status:** `open` — this is the gate for every row above.

## 9. Browser cold start — YouTube restored instead of Home

- **Status:** `done` for the cold start (observed), `open` for `Ctrl+Shift+T`
- **Seen:** a fresh launch, then `Ctrl+Shift+B`, opened the browser on YouTube,
  not the speed dial. The log names the reason:
  `show id=1 url=https://www.youtube.com/ ... resume=Some(true)` —
  `restoreSession()` put the last strip back into `tabs`, so the Home tab never
  existed. The same screenshot showed the restored page area white while
  `event page finished 1` had already been logged.
- **Fix:** `4880033` — a cold start always lands on the speed dial; the saved
  strip is kept as "recently closed" and comes back one tab at a time with
  `Ctrl+Shift+T`.
- **Evidence (installed build `ci-4880033`, SHA `6cc17001…`):** after a real
  launch + `Ctrl+Shift+B`, the browser rendered the speed dial with
  **`0 / 9 tabs`** and no YouTube tab in the strip. The log had **no**
  `show id=` / `create ok` line after launch — proof that no page webview was
  created on the way to Home.
- **Still unproven:** nothing — `Ctrl+Shift+T` was driven on the installed
  build (`ci-1fbadef`): Ctrl+Shift+T reopened the last active tab
  (`show id=1 url=https://www.perplexity.ai/session/…`, `create ok`,
  `event page finished` 6 s later).

## 10. Browser — pin, phir "T9 Editor LIT" → page dashboard ke upar

- **Status:** `done` — observed on the installed build
- **Seen (user report):** a site pinned, then the back button to the dashboard —
  the page did not disappear cleanly.
- **Cause in code:** `destroy_others` parked a pinned tab by resizing it to
  1×1 and nothing else. A 1×1 child HWND still exists and still paints until
  Windows processes the resize, so a slice of the page can sit over the
  dashboard; `browser_set_visible(false)` had the same hole and only ever
  parked the *active* tab, so any other live page stayed full size.
- **Fix:** `1fbadef` — `park_webview` calls `webview.hide()` after the resize
  (out of the compositor; Chromium keeps a hidden page's audio alive), and
  `browser_set_visible(false)` parks **every** `tab-*` webview, not just the
  active one. `wake_webview` calls `show()` before the rect is applied.
- **Evidence (installed build `ci-1fbadef`, SHA `e87ba5c7…`):** driven with
  real keys on the installed app — Ctrl+Shift+P then Ctrl+Shift+W then
  Ctrl+Shift+B:
  `event key 1 -> pinTab` · `pin request 1 -> true` ·
  `view closed -> swept all, 1 pinned kept` · `memory target tab-1 -> low` ·
  `show id=1 url=…youtube.com … resume=Some(true)` ·
  `memory target tab-1 -> normal`.
  The pinned page cannot paint over the dashboard while hidden, and comes back
  live on reopen. Screenshot: `%TEMP%\opencode\w-dashboard.png`.

## 11. Browser — heavy site load atak jata hai, refresh karna padta hai

- **Status:** `in-progress` — the stall is now *instrumented and bounded*;
  verification on the installed build is pending
- **Measured (12:49–12:51, installed `ci-fface3b`):** a reopen of the browser
  logged `view -> open` and `set_rect 1536x742 @ (0,121)` and then **nothing** —
  no `show id=`, no `refused`. The next `show` was a user reload two seconds
  later (`force=Some(true)`). That is the stall: the mount chain
  (`view open → restoreSession → rectSent → showActive`) never reached
  `showActive`, so no webview was ever created and the content box kept the
  shell's `… khul raha hai` placeholder. The reload button bypasses the chain
  (it calls `nudge` directly), which is why refresh "fixed" it.
- **Cause:** `restoreSession()` awaited `stats_kv_get` (a synchronous Rust
  command that opens `telemetry.db`). A call that stays pending has no
  rejection to catch, so the chain waited forever. It is invisible in the log
  because only the native side writes there.
- **Fix (commit `1e1400c`):**
  - `restoreSession` reads the strip with a 1.5 s deadline and the mount chain
    races it again — storage may delay the strip, never the first page.
  - New `browser_ui_note` command, so the UI writes into the same
    `browser-diag.log`: `mount -> restore done|timeout (tabs N)`,
    `mount -> rect ready, showActive`, and `showActive -> skipped (reason)` /
    `resume <id> <url>`.
  - The overlay effect names the popover that parked the page
    (`overlay -> park (profile+menu)`) — the 12:49 log had 15 park/restore
    pairs in 15 s with no way to tell which one.
- **Measured:** the log shows the whole webview being thrown away and rebuilt
  on the way to a new site:
  `show id=1 url=about:blank … show blank -> swept (kept [])` immediately
  followed by `show -> creating child webview` / `create ok`. Every such
  navigation is a cold WebView2 start (profile + uBlock unpack) that took
  **3–6 s** in the log, with a blank surface until the first paint.
- **Also measured:** `event page finished` fires 3–6 s after `event nav`, so the
  network is *not* stalling — the visible "atka hua" page is a surface that has
  no first paint yet, not a slow download.
- **Not yet ruled out:** renderer death (row 2 instrumentation is installed but
  no `process failed` line has been produced yet), and RAM starvation (the box
  runs at 80–96 % used).
- **Next:** verify on `ci-1e1400c` that a cold start's first browser open logs
  `mount -> restore done|timeout` **and** a `show id=` within ~2 s of
  `view -> open`, with the page painted in a screenshot; then close this row.
  Then stop the blank-tab sweep from destroying the page the user is about to
  navigate (reuse the webview, navigate it), and prove a paint after
  `page finished`.

## Next actions

1. **Decide the browser architecture** (row 4). Everything in rows 2–5 is a
   symptom of "one native webview per tab" on an 8 GB box. Fixing them one by one
   is what has produced three consecutive "shipped but still broken" rounds.
2. If the architecture stays: add `ProcessFailed` / unresponsive diagnostics with
   auto-reload (row 2), and prove one `event key` line from the page shim (row 5).
3. Re-verify rows 1 and 5 on the installed build, then close them honestly.

## How this file stays honest

- A row is closed by evidence: a log line, a screenshot, or a command output —
  not by a deploy report.
- The deploy ledger in `%LOCALAPPDATA%\T9EditorLIT\deploy\ledger.db` says what
  was **installed**; this file says what was **observed working**. They are
  different questions.
