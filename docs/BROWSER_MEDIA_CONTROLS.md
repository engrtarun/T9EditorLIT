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
| **OSD flyout** (bottom-right)      | artwork, title/channel, `02:22 ──●── 18:11`, prev/play/next    |
| Keyboard media keys                | same actions, whichever app window is focused                  |
| Realme Buds T310 (and any earbud)  | single press = play/pause, double press = next, as configured  |

Windows' own card has no room for two time labels and its seek bar is not
draggable on every build — the panel draws *no* time labels at all on this
machine (which is why Windhawk mods exist that inject a progress bar). The
controllable timeline therefore lives in the app's own **OSD flyout**: a
small undecorated window in the taskbar's corner that appears on play,
pause, a media key or a seek, and leaves after five quiet seconds unless the
pointer rests on it — Windows' OSD behaviour, with the timeline Windows
refuses to draw.

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
                                    ┌────────────────────────────────┼──────────────────────┐
                                    ▼                                ▼                      ▼
                        Windows SMTC session              `browser:media` event    media_flyout::ping/hide
                        (Win+A card artwork              (snapshot for the UI)     (show / hide the OSD,
                         + transport)                          │                     5 s auto-hide)
                                               MediaFlyout.svelte (flyout.html window)
                                                timeline + actions, bottom-right
                                                                            │
  earbud / media key / Win+A button ── ButtonPressed ───────────────────────┤
  OSD button / slider ── browser_media_action ──────────────────────────────┤
        smtc.rs ── window.__t9MediaAction(action, value) ──▶ the same page ◀──┘
```

- **Transitions show the OSD, heartbeats do not.** `smtc::update` calls
  `media_flyout::ping` only on play, play→pause, a fresh owner, or any
  transport/seek action (`media_flyout::ping` from `win::act`). A position
  heartbeat every ~1.5 s must *not* bring it back, or the card would never
  leave; `smtc::clear` hides it at once.

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
- **Artwork.** The flyout thumbnail is the page's own artwork URL: the shim
  reads `mediaSession.metadata.artwork` first and falls back to the page's
  `og:image` meta (YouTube often publishes only that), resolved against the
  page's base URL; `RandomAccessStreamReference::CreateFromUri` lets Windows
  download it, so a YouTube video shows its thumbnail like Edge does. Only
  `http(s)` URLs work — a `blob:` URL belongs to the page's renderer. The
  brand PNG baked into the binary (`icons/128x128.png` via `include_bytes!`)
  remains the final fallback, and the app identity is always "T9 Editor
  LIT". Every metadata change logs which one was used:
  `media <tab> -> playing "…" by "…" [thumb page: https://…]` —
  `[thumb brand: …]` with an empty URL means the page published nothing.
- **The OSD is independent.** `smtc::update` tracks reports and the owner
  even when the SMTC session could not be created, and emits the snapshot
  the card draws. The Win+A calls only run when `controls` exists.

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

## The OSD flyout — the timeline Windows refuses to draw

`media_flyout.rs` owns a second, tiny window — `flyout.html` →
`src/flyout.ts` → `MediaFlyout.svelte`, label `media-flyout`, listed in
`capabilities/default.json` — in the taskbar's bottom-right corner. It is
created **on the first media event only**: a second webview on an 8 GB
machine is not a cost to pay at startup.

- **Shown without activating** (`SW_SHOWNOACTIVATE`), so keyboard focus
  never leaves the page when a video starts. If the user had clicked the
  card and it hides while focused, the main window gets that focus back.
- **Positioned on the main window's monitor work area**, `MARGIN` inside the
  bottom-right corner — never under the taskbar (the rule is a pure
  function, unit-tested in `media_flyout::tests`).
- **Five quiet seconds and it leaves** (a watchdog polls every 400 ms); the
  pointer resting on the card slides that deadline. Play, play→pause, a
  fresh owner, any media key/earbud press and any seek bring it back —
  position heartbeats deliberately do not.
- The window is its own webview with no access to the main window's stores,
  so it draws one snapshot and nothing else: artwork, title/channel, the
  clock, the slider, the transport buttons.
- Every accepted report becomes a `browser:media` event; the card uses the
  position from each report and interpolates in between (4 Hz), so the
  clock moves smoothly without an IPC call per frame.
- Dragging the slider only updates local state; on release it calls
  `browser_media_action('seek', seconds)`. Rust validates the action and
  runs `window.__t9MediaAction('seek', …)` in the owning page — the same
  `seekto` handler the Win+A card uses.
- Play/pause/next/previous are `browser_media_action` too, so the OSD, the
  Win+A card and the earbud share one implementation.
- `browser_media_state` gives a newly created card its first paint, so a
  **paused** video (which sends no heartbeats) still shows.
- The browser view reserves **no** height for a timeline any more:
  `BrowserView.svelte` mounts nothing above the content rect, so the page
  gets its full rectangle back (`NowPlaying.svelte` is gone).

## Verifying it on the installed app

1. Open the browser, play a YouTube video.
2. `Win + N` — the Windows card must show **T9 Editor LIT**, the video's
   thumbnail and its title.
3. The **OSD flyout** must pop up at the bottom-right with
   `current ── slider ── total`. Drag the slider to the middle — the video
   must jump there. Stop touching it: after ~5 s the card must disappear;
   a media key or another seek must bring it back, and hovering it must
   keep it on screen.
4. Press the earbud once (pause), double-press (next video) — both must act
   within a fraction of a second, the OSD must reappear with the new item,
   and its clock must follow.
5. `%LOCALAPPDATA%\T9EditorLIT\browser-diag.log` must contain:

   ```text
   smtc -> enabled (brand thumb ok)
   media <tab> -> playing "…" by "…" [thumb page: https://…]
   media flyout -> created
   media flyout -> shown
   media button next -> <tab>
   media button seek -> <tab>
   media flyout -> hidden
   ```

If the Windows card says "Unknown app", the AUMID is not reaching the
session: re-run `tools\pin-taskbar.ps1`, then relaunch the installed exe
(the process AUMID is read at startup). If buttons are dead, check for the
`media …` line — no line means the page never reported a media element.
`[thumb brand: ]` with an empty URL means the page published no artwork at
all (the `og:image` fallback had nothing either); `[thumb page: <url>]`
with no image in Win+N means Windows failed to download that URL — the OSD
still shows it, because the card's webview fetches it directly.
