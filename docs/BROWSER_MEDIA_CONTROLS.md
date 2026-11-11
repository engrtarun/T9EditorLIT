# Media controls — the Windows flyout, media keys and earbuds

The in-built browser plays YouTube inside a WebView2 child. Chromium has its
own media session for that page, and that session belongs to
`msedgewebview2.exe` — which is why the Windows media flyout said **"Unknown
app"** and an earbud press had two possible owners. T9 owns exactly one session
for the whole app now, and this document is the contract.

## What the user sees

| Surface                            | What it shows / does                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| Windows media flyout (Win + N)     | **T9 Editor LIT** + the brand icon, video title, channel name |
| Flyout transport row               | play/pause, stop, previous, next, −10 s, +10 s                |
| Flyout seek bar                    | the page's real position; dragging it seeks the page          |
| Keyboard media keys                | same actions, whichever app window is focused                 |
| Realme Buds T310 (and any earbud)  | single press = play/pause, double press = next, as configured |

The buttons are enabled only when they mean something: **next/previous** turn
on when the page registered `nexttrack` / `previoustrack` (YouTube on a
playlist or a watch page does), so a dead button is never shown.

## How it works

```text
page (WebView2 child)
  browser_shim.js ── { t9: 'media', state, title, artist, … } ──▶ browser.rs
                                                                     │
                                                          smtc::update (Rust)
                                                                     │
                                                        Windows SMTC session
                                                                     │
  earbud / media key / flyout button ── ButtonPressed ───────────────┘
        smtc.rs ── window.__t9MediaAction('next') ──▶ the same page
```

- **One owner.** `SystemMediaTransportControls` is created for the main
  window's HWND (`ISystemMediaTransportControlsInterop::GetForWindow`) in
  `smtc.rs`, at startup.
- **Chromium's session is off.** Every tab webview is created with
  `--disable-features=…,MediaSessionService,HardwareMediaKeyHandling`
  (`TAB_BROWSER_ARGS` in `browser.rs`). That is what removes the "Unknown
  app" duplicate and the arbitration delay on earbud presses. The page's
  `navigator.mediaSession` still exists; the shim wraps `setActionHandler` so
  handler registration never throws and the handlers are still callable.
- **Identity.** The process declares the app's AUMID at startup
  (`set_process_aumid` in `lib.rs`, using `tauri.conf.json`'s identifier), and
  the Start-menu shortcut carries the same AUMID (`tools/pin-taskbar.ps1`).
  Windows resolves that pair to the shortcut's display name and icon — the
  same mechanism that makes notifications say "T9 Editor LIT".
- **Artwork.** The flyout thumbnail is the brand PNG baked into the binary
  (`icons/128x128.png` via `include_bytes!`), so it is the real mark even
  before a page sends a poster frame.

## Shim messages

`browser_shim.js` reports on media events (`play`, `pause`, `timeupdate`,
`seeked`, …) with a 1.4 s floor, plus a heartbeat while playing:

```json
{
  "t9": "media",
  "state": "playing",
  "title": "…",
  "artist": "…",
  "album": "youtube.com",
  "position": 123.5,
  "duration": 1200.0,
  "rate": 1,
  "next": true,
  "prev": true
}
```

`state` is `playing`, `paused`, or `none`. Rust ignores position-only reports
for metadata (no flyout flicker) and always updates the timeline. A tab that
reports `none`, closes, or is swept from a non-pinned tab clears the session
(`PlaybackStatus::Closed`); a **pinned** tab keeps it, which is the whole point
of pinning YouTube while editing.

## Verifying it on the installed app

1. Open the browser, play a YouTube video.
2. `Win + N` — the flyout must show **T9 Editor LIT** and the video's title.
3. Press the earbud once (pause), double-press (next video) — both must act
   within a fraction of a second.
4. `%LOCALAPPDATA%\T9EditorLIT\browser-diag.log` must contain:

   ```text
   smtc -> enabled
   media <tab> -> playing "…" by "…"
   media button next -> <tab>
   ```

If the flyout says "Unknown app", the AUMID is not reaching the session:
re-run `tools\pin-taskbar.ps1`, then relaunch the installed exe (the process
AUMID is read at startup). If buttons are dead, check for the `media …` line —
no line means the page never reported a media element.
