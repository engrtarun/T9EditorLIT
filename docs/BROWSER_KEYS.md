# Firefox keyboard shortcuts — the exact list, and where T9 stands

The in-built browser's key map is no longer folklore. Every row below is
Firefox **on Windows**; the right-hand column says what T9 does with it.

Sources (checked 1 Nov 2026):

- Mozilla's official shortcut article:
  `support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly`
  — it sits behind a bot check, so the table here was cross-verified against
  the two copies below.
- Mozilla's archived official keyboard page:
  `www-archive.mozilla.org/support/firefox/keyboard` (static, Windows column).
- Wikipedia, _Table of keyboard shortcuts_ — the Firefox annotations in the
  browser/tab tables (reopen-closed, move-tab, Ctrl+9 and friends).

Legend: **✅ working** · **🔁 mapped** (the app equivalent differs and the
reason is written) · **⛔ not available** (with the reason).

## Tabs & windows

| Key                                  | Firefox action            | T9 browser view                                                              |
| ------------------------------------ | ------------------------- | ---------------------------------------------------------------------------- |
| Ctrl + T                             | New tab                   | ✅ new tab                                                                   |
| Ctrl + W / Ctrl + F4                 | Close tab                 | ✅ close; the **last** tab closes the browser view (Firefox rule)            |
| Ctrl + Shift + T                     | Reopen last closed tab    | ✅ restores at its old slot, 20-deep                                         |
| Ctrl + Tab / Ctrl + PgDn             | Next tab                  | ✅ wraps around                                                              |
| Ctrl + Shift + Tab / Ctrl + PgUp     | Previous tab              | ✅ wraps around                                                              |
| Ctrl + 1 … 8                         | Select tab n              | ✅                                                                           |
| Ctrl + 9                             | Select the last tab       | ✅                                                                           |
| Ctrl + Shift + PgUp / PgDn           | Move tab left / right     | ✅ reorders the strip                                                        |
| Ctrl + N                             | New **window**            | 🔁 new tab — T9 is a single-window app                                       |
| Ctrl + Shift + W / Ctrl + Shift + F4 | Close window              | 🔁 closes the browser view and returns to the editor                         |
| Ctrl + Shift + P                     | New private window        | ⛔ one window, no profile isolation — a "private" toggle here would be a lie |
| Ctrl + Shift + N                     | Reopen last closed window | ⛔ same single-window reason                                                 |

## Navigation

| Key                                                 | Firefox action                               | T9 browser view                                                                                         |
| --------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Alt + ← / Backspace                                 | Back                                         | ✅ store history stack                                                                                  |
| Alt + → / Shift + Backspace                         | Forward                                      | ✅                                                                                                      |
| F5 / Ctrl + R                                       | Reload                                       | ✅                                                                                                      |
| Ctrl + F5 / Ctrl + Shift + R                        | Reload, override cache                       | ✅ same forced nudge — T9 never shows a cached page from the old webview                                |
| Esc                                                 | Stop loading                                 | ✅ the loading spinner stops (the JS-visible half; the WebView2 "cancel navigation" API is not exposed) |
| Alt + Home                                          | Home page                                    | ✅ the speed dial **is** the home page                                                                  |
| Ctrl + L / Alt + D                                  | Focus address bar                            | ✅ (the toolbar magnifier's tooltip now tells the truth)                                                |
| Ctrl + K                                            | Focus search bar                             | ✅ same pill; a phrase becomes a Brave search                                                           |
| Ctrl + E / F6                                       | Tab search / cycle chrome ↔ page             | ⛔ v1 — the address bar already searches, and F6 inside a WebView2 child belongs to the page            |
| Ctrl + Enter / Shift + Enter / Ctrl + Shift + Enter | Complete `.com` / `.net` / `.org` in the bar | ⛔ the URL bar has no autocomplete yet (`toUrl` is the whole parser)                                    |

## Page, bookmarks & panels

| Key                                   | Firefox action                  | T9 browser view                                                                                                                               |
| ------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Ctrl + D                              | Bookmark this page              | ✅ star in the address bar; pins appear on the speed dial (persisted per machine)                                                             |
| Ctrl + Shift + D                      | Bookmark all tabs               | ✅ every real URL becomes a pin                                                                                                               |
| Ctrl + B / Ctrl + Shift + O           | Bookmarks sidebar / library     | 🔁 the speed dial is the bookmark surface (B/O open it)                                                                                       |
| Ctrl + H                              | History sidebar                 | ✅ the slide-up History panel (bounded 80-entry log, newest first)                                                                            |
| Ctrl + J                              | Downloads                       | ✅ the existing downloads panel                                                                                                               |
| Ctrl + Shift + Del                    | Clear recent history            | ✅ clears the T9 log + closed stack and wipes the active page's WebView2 profile                                                              |
| Ctrl + P                              | Print                           | ✅ WebView2's own print dialog (core-webview `print`)                                                                                         |
| Ctrl + S                              | Save page as                    | 🔁 hands the URL to the daemon's multi-segment downloader                                                                                     |
| Ctrl + O                              | Open file                       | 🔁 opens the app's import dialog                                                                                                              |
| Ctrl + U                              | Page source                     | ✅ `view-source:` round trip (second press returns to the page)                                                                               |
| Ctrl + I                              | Page info                       | ⛔ no chrome info page to show                                                                                                                |
| Ctrl + F / F3 / Ctrl + G / Shift + F3 | Find in page / again / previous | ⛔ WebView2 exposes no find API to JS; the keys answer with an honest toast. (The editor's transcript search is a separate, working surface.) |
| `/` and `'`                           | Quick find (text / links only)  | ⛔ same find API reason                                                                                                                       |

## Zoom, devtools, the rest

| Key                                                    | Firefox action        | T9 browser view                                                                                              |
| ------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Ctrl + = / Ctrl + Shift + = / Ctrl + - / Ctrl + 0      | Zoom in / out / reset | ✅ real page zoom inside the child webview (0.2 … 10, 20 % steps)                                            |
| F12 / Ctrl + Shift + I / K / C / E / J / M / S         | DevTools suite        | ⛔ release builds compile devtools out, and Tauri documents child-webview devtools as unsupported on Windows |
| Ctrl + Shift + A                                       | Add-ons manager       | ⛔ there is no add-on system                                                                                 |
| F7                                                     | Caret browsing        | ⛔ WebView2 has no caret-browsing API                                                                        |
| F11                                                    | Full screen           | ⛔ the window-controls contract doesn't grant fullscreen; use the window's own buttons                       |
| F1                                                     | Help                  | ✅ opens this shortcut sheet                                                                                 |
| Ctrl + X / C / V / A / Z, Del, Ctrl + Shift + V        | Text editing          | ℹ️ native — plain inputs and the page webview handle these themselves                                        |
| Space / Shift + Space, PgUp / PgDn, Home / End, arrows | Page scroll           | ℹ️ native inside the page                                                                                    |

## How the focus works (read this before "the keys don't work")

T9's browser is a **native child webview** inside the app window, exactly like
Firefox's page area. Keyboard events go to whatever has focus:

- **T9 chrome has focus** (tab strip, toolbar, address bar, panels) → the map
  above runs. Ctrl+L / Ctrl+K even re-focus the address bar _while you are
  typing in it_, like Firefox.
- **The page has focus** (you clicked inside the page) → the page owns its
  keyboard, as it should. Ctrl+L / Ctrl+Tab from inside a page reach the page
  first in this build; click the toolbar once and they work.

The editor keys are a separate, rebindable map (`src/lib/stores/keys.svelte.ts`)
and never fire in the browser view; these browser keys never fire in the
editor. The single source of truth for the browser table is
`src/lib/browser-keys.ts` — the shortcut sheet renders from it, and
`src/lib/browser-keys.test.ts` drives every combo against a recorder, so a
binding cannot rot silently.
