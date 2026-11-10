# uBlock Origin Lite in the built-in browser

The browser ships with [uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home)
on by default and updates itself. Nothing about it needs a user click.

Why Lite and not classic uBlock Origin: classic uBO is Manifest V2. Chromium
removed MV2 in version 139, so the old extension still appeared in the profile
while filtering **nothing** — which is exactly how "uBlock is loaded" and
"YouTube still shows ads" were both true on this machine. uBOL is the same
upstream project (same filter lists) in the only manifest current Chromium
still runs.

## Where the pieces live

| Piece | Owner | Path / endpoint |
| --- | --- | --- |
| uBlock source (provenance only) | git submodule | `modules/uBlock` (classic uBO source, reference) |
| Official release archive | Go daemon | GitHub release `uBOLite_<ver>.chromium.zip` |
| Unpacked extension | Go daemon | `%LOCALAPPDATA%\T9EditorLIT\ublock\extensions-mv3\uBOLite.chromium` |
| Legacy MV2 folder (deleted on start) | Go daemon | `%LOCALAPPDATA%\T9EditorLIT\ublock\extensions\uBlock0.chromium` |
| Install marker | Go daemon | `%LOCALAPPDATA%\T9EditorLIT\ublock\version.json` |
| Disk status | Go daemon | `GET /v1/ublock/status` |
| Manual re-check | Go daemon | `POST /v1/ublock/update` |
| WebView2 load | Rust | `browser_extensions_enabled(true).extensions_path(...)` on a **dedicated tab profile** (`%LOCALAPPDATA%\T9EditorLIT\browser-profile`) |
| Runtime proof | Rust + WebView2 | `ICoreWebView2Profile7::GetBrowserExtensions` → `browser:extensions` |
| Panel UI | Svelte | Browser toolbar ☰ → uBlock Origin Lite section (also downloader settings) |

## Why the release zip, not the submodule

The submodule is there so a reviewer can read the exact source that is being
shipped and diff it against the release. Building the extension here is not
part of the deal: the project's own release pipeline produces the Chromium
archive and publishes its SHA-256 in the GitHub release metadata. The daemon
downloads that archive, verifies the digest, and refuses a mismatch. A local
build would be slower, unreviewable byte-wise, and would still not be what
upstream ships.

To bump a future classic-uBO snapshot (reference only — the daemon downloads
uBOL from `uBOL-home` releases):

```powershell
git -C modules/uBlock fetch --tags --depth 1
git -C modules/uBlock checkout <tag>     # e.g. 1.76.0
git add modules/uBlock
```

The daemon does not read the submodule at runtime. A new release is picked up
automatically on the next check.

## The update loop

`go/internal/ublock`:

1. ask GitHub for the latest release (`api.github.com/repos/uBlockOrigin/uBOL-home/releases/latest`);
2. compare the tag with `version.json` **and** the unpacked `manifest.json`;
3. if different, download `*.chromium.zip`, hashing while it streams;
4. reject a digest mismatch, an oversized archive, or a zip entry that escapes
   the destination;
5. find the archive root (uBOL packs `manifest.json` at the top level; a nested
   folder is also accepted), unpack to a temp folder, then swap it into place
   (the old folder steps aside first, so a failed swap restores the working
   version);
6. write `version.json` only after the swap succeeded;
7. delete the dead MV2 `extensions/uBlock0.chromium` folder, best-effort.

The check runs at daemon start and every 6 hours (`checkEvery`). A failure is
recorded in `Status.Error` and retried on the next tick — it never blocks a
download and never crashes the daemon.

`POST /v1/ublock/update` claims the in-flight flag and returns immediately
(`updating: true`). The UI polls the status endpoint while that flag is set.

## The honest runtime claim

`extensions_path` is fire-and-forget in wry: it calls
`AddBrowserExtension` per folder and ignores the result. So a folder on disk
proves the *download*, not the *load*.

The only runtime truth is WebView2's own list. After a tab becomes visible,
Rust asks the profile (`ICoreWebView2Profile7::GetBrowserExtensions`) and emits
`browser:extensions` with the names and enabled flags. The panel shows
`loaded` only when that list contains uBlock and it is enabled; otherwise it
shows `not loaded` and the reason (including a timeout or an old WebView2
runtime that lacks the interface).

## Manifest V3

uBOL is Manifest V3. It filters with `declarativeNetRequest` (static rulesets)
plus the same cosmetic filters, so it does not need the `webRequestBlocking`
permission MV3 removed. The unpacked manifest declares `manifest_version: 3`
and `minimum_chrome_version: 122`; the installed WebView2 runtime is Chromium
157, so it both loads and actually filters.

The extension folder is `extensions-mv3` on purpose. Chromium 139+ refuses MV2
outright, and pointing WebView2 at a fresh path guarantees a leftover MV2
folder can never be scanned again — even if an earlier session left it behind.

One extension folder per extensions path: wry's `extensions_path` adds every
child folder, so a second extension in the same parent would be loaded too.

## RAM

The extension is unpacked on disk and loaded by WebView2; it does not add a
process of its own per tab. It runs inside the existing tab webview, and the
browser's structural budget is unchanged: at most two child webviews (active +
one kept at 1×1 px), with the kept one set to
`COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW` and the active one back to
`NORMAL`.

The one exception is a **pinned tab**: it is the user's explicit "keep this
alive" (YouTube playing while another tab is open, or while editing). A pinned
webview is parked at 1×1 and set to `LOW`, so it costs no pixels and no
render work, but audio and page state keep running.

## Why tabs have their own WebView2 profile

The regression that blanked every tab after uBlock arrived: WebView2 allows
exactly one set of environment options per user-data folder. The app shell
creates its default environment with extensions **off**; a tab then asked for
the same folder with extensions **on**, which WebView2 rejects with
`HRESULT(0x8007139F)` (`ERROR_INVALID_STATE`) before a single window is
created. Tabs now use `%LOCALAPPDATA%\T9EditorLIT\browser-profile`:

- the shell's environment stays untouched;
- every tab in the profile keeps identical options, so adding uBlock later
  cannot invalidate an already-open environment;
- the browser gets its own cookie/login jar, so a change in UI storage
  cannot log the user out of every site.

If a runtime still refuses the extensions-enabled environment (`0x8007139F`),
the tab builder flips a process flag, disables extensions for the rest of the
session, and retries the tab without them. The panel reports `not loaded`
with the reason; tabs keep working. Any other create error (for example a
duplicate label from two `show` calls racing) is **not** treated as an
extension failure — that misread is what kept uBlock off for a whole session.

## Auto-update and the profile

The daemon swaps the unpacked folder on a new release. WebView2's rule is
that changing the folder content removes the extension from the profile, so
`AddBrowserExtension` on the next tab creation reinstalls the new version —
no manual work and no app restart required, as long as a tab is created
after the swap. The panel's "Check now" button forces the daemon to fetch
and swap; the next tab open picks it up.

## Smoke probe

`T9_BROWSER_SMOKE=1` runs the installed app's production tab builder on a
hidden 1×1 webview, asks the profile which extensions actually loaded, writes
the verdict to `browser-diag.log`, and exits with 0 (uBlock loaded) or 3/4
(missing / create failed). It is the evidence lane for the CI build: no
compile, no click.
## Tests

`go test ./internal/ublock` covers:

- install + no redownload when the release is unchanged;
- a new release replaces the old one;
- a bad digest never touches the extension folder;
- zip traversal is rejected;
- a broken update keeps the working version;
- a fresh status is honest (`installed: false`, `enabled: true`, `autoUpdate: true`);
- `UpdateNow` actually performs the check (the "button did nothing" regression).
