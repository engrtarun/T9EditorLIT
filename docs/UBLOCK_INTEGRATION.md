# uBlock Origin in the built-in browser

The browser ships with [uBlock Origin](https://github.com/gorhill/uBlock) on by
default and updates itself. Nothing about it needs a user click.

## Where the pieces live

| Piece | Owner | Path / endpoint |
| --- | --- | --- |
| uBlock source (provenance only) | git submodule | `modules/uBlock` |
| Official release archive | Go daemon | GitHub release `uBlock0_<ver>.chromium.zip` |
| Unpacked extension | Go daemon | `%LOCALAPPDATA%\T9EditorLIT\ublock\extensions\uBlock0.chromium` |
| Install marker | Go daemon | `%LOCALAPPDATA%\T9EditorLIT\ublock\version.json` |
| Disk status | Go daemon | `GET /v1/ublock/status` |
| Manual re-check | Go daemon | `POST /v1/ublock/update` |
| WebView2 load | Rust | `browser_extensions_enabled(true).extensions_path(...)` |
| Runtime proof | Rust + WebView2 | `ICoreWebView2Profile7::GetBrowserExtensions` → `browser:extensions` |
| Panel UI | Svelte | Downloads → gear → "uBlock Origin" row |

## Why the release zip, not the submodule

The submodule is there so a reviewer can read the exact source that is being
shipped and diff it against the release. Building the extension here is not
part of the deal: uBlock's own release pipeline produces the Chromium archive
and publishes its SHA-256 in the GitHub release metadata. The daemon downloads
that archive, verifies the digest, and refuses a mismatch. A local build would
be slower, unreviewable byte-wise, and would still not be what upstream ships.

To bump the source snapshot:

```powershell
git -C modules/uBlock fetch --tags --depth 1
git -C modules/uBlock checkout <tag>     # e.g. 1.76.0
git add modules/uBlock
```

The daemon does not read the submodule at runtime. A new release is picked up
automatically on the next check.

## The update loop

`go/internal/ublock`:

1. ask GitHub for the latest release (`api.github.com/repos/gorhill/uBlock/releases/latest`);
2. compare the tag with `version.json` **and** the unpacked `manifest.json`;
3. if different, download `*.chromium.zip`, hashing while it streams;
4. reject a digest mismatch, an oversized archive, or a zip entry that escapes
   the destination;
5. unpack to a temp folder, then swap it into place (the old folder steps
   aside first, so a failed swap restores the working version);
6. write `version.json` only after the swap succeeded.

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

## Manifest V2 caveat

uBlock Origin's Chromium build is Manifest V2 (it uses `webRequestBlocking`,
which MV3 removed for non-enterprise extensions). Whether WebView2 loads it
depends on the installed WebView2 runtime. The app does not pretend otherwise:
if the profile does not list the extension, the panel says so. `modules/uBlock`
and the release artifact stay MV2 until upstream ships a supported MV3 build.

## RAM

The extension is unpacked on disk and loaded by WebView2; it does not add a
process of its own per tab. It runs inside the existing tab webview, and the
browser's structural budget is unchanged: at most two child webviews (active +
one kept at 1×1 px), with the kept one set to
`COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW` and the active one back to
`NORMAL`.

## Tests

`go test ./internal/ublock` covers:

- install + no redownload when the release is unchanged;
- a new release replaces the old one;
- a bad digest never touches the extension folder;
- zip traversal is rejected;
- a broken update keeps the working version;
- a fresh status is honest (`installed: false`, `enabled: true`, `autoUpdate: true`);
- `UpdateNow` actually performs the check (the "button did nothing" regression).
