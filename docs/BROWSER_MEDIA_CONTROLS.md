# Media controls — the Windows flyout, media keys and earbuds

The in-built browser plays YouTube inside a WebView2 child. Chromium has its
own media session for that page, and that session belongs to
`msedgewebview2.exe` — which is why the Windows media flyout said **"Unknown
app"** and an earbud press had two possible owners. T9 owns exactly one session
for the whole app now, and this document is the contract.

## What the user sees

| Surface                            | What it shows / does                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| Windows media flyout (Win + N)     | **T9 Editor LIT** + the video's artwork, title, channel name   |
| Flyout transport row               | play/pause, stop, previous, next, −10 s, +10 s                 |
| Flyout seek bar                    | the page's real position; dragging it seeks the page           |
| In-app now-playing bar             | artwork, title/channel, `02:22 ──●── 18:11`, prev/play/next    |
| Keyboard media keys                | same actions, whichever app window is focused                  |
| Realme Buds T310 (and any earbud)  | single press = play/pause, double press = next, as configured  |

The in-app bar exists because Windows' flyout has no room for two time labels
and its seek bar is not draggable on every build. It sits between the address
bar and the page, shows `current / total`, and its slider is draggable — that
is the timeline Edge cannot give this app through SMTC.

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
                                    ┌────────────────────────────────┴──────────┐
                                    ▼                                           ▼
                        Windows SMTC session                     `browser:media` event
                        (flyout artwork + transport)                         │
                                                                   NowPlaying.svelte
                                                                    (timeline + actions)
                                                                            │
  earbud / media key / flyout button ── ButtonPressed ───────────────────────┤
  in-app bar button / slider ── browser_media_action ────────────────────────┤
        smtc.rs ── window.__t9MediaAction(action, value) ──▶ the same page ◀──┘
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
- **Artwork.** The flyout thumbnail is the page's own
  `mediaSession.metadata.artwork` URL (the shim resolves it to an absolute URL;
  `RandomAccessStreamReference::CreateFromUri` lets Windows download it), so a
  YouTube video shows its thumbnail like Edge does. Only `http(s)` URLs work —
  a `blob:` URL belongs to the page's renderer. The brand PNG baked into the
  binary (`icons/128x128.png` via `include_bytes!`) remains the fallback, and
  the app identity is always "T9 Editor LIT".
- **The bar is independent.** `smtc::update` tracks reports and the owner even
  when the SMTC session could not be created, and emits the snapshot the bar
  draws. The flyout calls only run when `controls` exists.

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
  "artwork": "https://i.ytimg.com/…/maxresdefault.jpg",
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
(`PlaybackStatus::Closed`) and emits `browser:media` with `state: "none"`; a
**pinned** tab keeps it, which is the whole point of pinning YouTube while
editing.

## The in-app time line

`NowPlaying.svelte` is mounted by `BrowserView.svelte` **above** the
`[data-focus="browser-content"]` rectangle — never inside it. The child webview
is positioned exactly over that rect and paints above the DOM, so a bar inside
it would be invisible under the page. Outside, the rect shrinks by the bar's
height and `browser_set_rect` moves the native page below it.

- Every accepted report becomes a `browser:media` event. The bar uses the
  position from each report and interpolates in between (4 Hz), so the clock
  moves smoothly without an IPC call per frame.
- Dragging the slider only updates local state; on release it calls
  `browser_media_action('seek', seconds)`. Rust validates the action and runs
  `window.__t9MediaAction('seek', …)` in the owning page — the same
  `seekto` handler the flyout uses.
- Play/pause/next/previous are `browser_media_action` too, so the bar, the
  flyout and the earbud share one implementation.
- A page in the Fullscreen API hides the bar (`invisible`, not unmounted) —
  the layout stays stable while Rust's grown webview covers the window.
- `browser_media_state` gives a newly mounted bar the owner's last report, so
  a **paused** video (which sends no heartbeats) still shows after leaving and
  re-entering the browser.

## Verifying it on the installed app

1. Open the browser, play a YouTube video.
2. `Win + N` — the flyout must show **T9 Editor LIT**, the video's thumbnail
   and its title.
3. The in-app bar must show `current ── slider ── total`; drag the slider to
   the middle and the video must jump there.
4. Press the earbud once (pause), double-press (next video) — both must act
   within a fraction of a second; the bar's clock must follow.
5. `%LOCALAPPDATA%\T9EditorLIT\browser-diag.log` must contain:

   ```text
   smtc -> enabled
   media <tab> -> playing "…" by "…"
   media button next -> <tab>
   media button seek -> <tab>
   ```

If the flyout says "Unknown app", the AUMID is not reaching the session:
re-run `tools\pin-taskbar.ps1`, then relaunch the installed exe (the process
AUMID is read at startup). If buttons are dead, check for the `media …` line —
no line means the page never reported a media element.
