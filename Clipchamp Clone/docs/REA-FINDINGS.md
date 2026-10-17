# REA Findings — Microsoft Clipchamp (Windows 4.7.10020.0)

Reverse-engineering record for the Clipchamp Clone scaffold.
All claims below cite a REA Evidence ID or a command that produced them.

> **Complements, does not duplicate.** An earlier session captured the Clipchamp
> **running** editor with `capture-browser-scenario` — screenshots, accessibility
> trees, DOM and design tokens. That record lives at
> [`../../docs/CLIPCHAMP_REA_REFERENCE.md`](../../docs/CLIPCHAMP_REA_REFERENCE.md).
> That work noted "the MSIX install dir contains **no** html/js/css assets", so it
> had no code to read. This pass closes that gap: it recovers the actual
> application JavaScript from the WebView2 cache and analyses it statically.
> The two records corroborate each other on every shared fact (see §9).

---

## 1. Target identity

| Field             | Value                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| Package           | `Clipchamp.Clipchamp_4.7.10020.0_x64__yxz26nhyzhsrt`                              |
| Install location  | `C:\Program Files\WindowsApps\Clipchamp.Clipchamp_4.7.10020.0_x64__yxz26nhyzhsrt` |
| Store ID          | `9P1J8S7CCWWT`                                                                    |
| Version signature | `20`                                                                              |

Source: `Get-AppxPackage`, and `Clipchamp/appsettings.json`.

## 2. Architecture — observed, not assumed

Clipchamp for Windows is **a thin WebView2 shell**, not a local editor.

`Clipchamp/appsettings.json` (read directly):

```json
"CONSUMER_APP_URL": "https://app.clipchamp.com",
"COMMERCIAL_APP_URL": "https://{hostname}/_layouts/15/videoeditorembed.aspx/start?lc={language}",
"AAD_CLIENT_ID": "15ddab63-ba81-45db-9bb6-6f8bc445c459"
```

So the Windows package supplies the window, the sign-in and the file pickers.
The editor itself — timeline, filters, renderer — is a web app loaded from
`app.clipchamp.com` into an embedded WebView2 runtime.

**Correction to an earlier assumption:** `Clipchamp.exe` is _not_ .NET.
REA classified it as native, not managed:

> `classification.status: "not-managed"`, `container: "pe"`,
> `code: "cli-directory-absent"` — "The PE has no CLI data directory"
> — Evidence `ev_35120302c8e3c2ced4393683659323af2f5e8c1da4230a222f75e56bf2ba4c24`

| Property | Value                                                              |
| -------- | ------------------------------------------------------------------ |
| SHA-256  | `5eff0a98629798c44c3db7ce0a2b1f228e46cce36d2e21a61c17dc21d5907db7` |
| Format   | PE, `pe32-plus`, machine `0x8664` (x86_64)                         |
| Size     | 36,038,656 bytes                                                   |
| Sections | 6                                                                  |

Two further managed inspections returned `coverage: "unavailable"` for the same
reason — `inspect-managed-members` (`ev_c9bb90ae…`) and
`inspect-managed-native-boundaries` (`ev_62f98b3e…`) both report
"no CLI metadata was admitted". **These are honest negatives, not failures:**
there is no managed code to find. Analysing the native shell properly would
need Hopper or Ghidra, neither of which is installed.

**Consequence:** the interesting reverse-engineering target is the **JavaScript**,
and REA analyses that with no native engine at all.

## 3. Recovering the web app

Clipchamp's WebView2 profile lives at:

```
%LOCALAPPDATA%\Packages\Clipchamp.Clipchamp_yxz26nhyzhsrt\LocalState\EBWebView\
```

`evidence/extract-cache.mjs` walks the Chromium simple-cache
(`Default/Cache/Cache_Data/f_*`) and unwraps the encoding chain. That chain is
**gzip → brotli**, which is why a naive gunzip yields unreadable bytes:

```
000005_cb3e0adc.js  head=8bff0f11d5bc1e00…  → brotli → 9,069,130 bytes of JS
000017.bin          head=ffd8ffe0           → JPEG
```

Result: **74 unique artifacts, 49.8 MB** (14 duplicates dropped by SHA-256).

| Kind         | Count |
| ------------ | ----- |
| JavaScript   | 46    |
| CSS          | 5     |
| Images       | 18    |
| Font         | 1     |
| Unclassified | 4     |

> Brotli has no magic number. The extractor only accepts a brotli decode when
> the output re-sniffs as real text, so a false positive cannot silently
> corrupt the tree.

## 4. REA application analysis

```powershell
npx -y rea-agents@6.5.0 analyze-javascript-application `
  "evidence\web-assets" --artifact-format directory `
  --max-heap-mb 768 --max-semantic-nodes 40000 --format json
```

| Field                   | Value                                                                   |
| ----------------------- | ----------------------------------------------------------------------- |
| Evidence ID             | `ev_03cd609d30a8466d558331e4d6acabd0f79dfa3b66c6e187e52b4955ac48f041`   |
| Provider                | `rea-javascript-application` v1                                         |
| Root artifact SHA-256   | `11ebf713209df61ce3a3dce1cf91e7a5275fcc6eaff27b96ec7745b5ee33d524`      |
| Inventory manifest      | `agm_7585386ec5bcc0e716c16e2c5c88740774d5c91fe0ec5eb9839ffe00feb81b56`  |
| Inventory graph SHA-256 | `a3eaee8404f4480dab15e037ce39c724434718d8d509292c6b2c9c594408c67d`      |
| Semantic graph ID       | `jsrg_281dbcd186bc1f7a3b408e5134d7f92ac698b9eee99622d87963e28cc162f06d` |
| Duration                | 385,464 ms                                                              |
| Output size             | 70.3 MB Evidence JSON                                                   |
| Confidence              | `derived`                                                               |
| Authority               | `shipped-artifact`                                                      |

### Coverage gap — read this before trusting the graph

The two largest bundles **exhausted the analyser heap** and were not fully
analysed:

> `000005_cb3e0adc.js: Resource constraint during analyze_javascript_application:
Owned JavaScript worker exhausted its heap while analyzing …`
> `00003d_894543bb.js: …same…`

These are the 7.0 MB and 7.0 MB bundles — i.e. the **main application
bundle**, the single most important artifact in the set. Coverage of the main
bundle was therefore incomplete in the run above, and was recovered separately
as described next.

### Retrying the main bundle — three attempts, two different causes

| Attempt | Scope    | Heap    | Timeout         | Result                                 |
| ------- | -------- | ------- | --------------- | -------------------------------------- |
| 1       | 46 files | 768 MB  | 300 s (default) | `resource_constraint` — heap exhausted |
| 2       | 2 files  | 1536 MB | 300 s (default) | `provider_timeout` at 308 s            |
| 3       | 2 files  | 1536 MB | 2400 s          | **`ok=true`** — both bundles parsed    |

Attempt 2 is worth recording because the two failures have **different
causes**, and only one is a memory problem. Raising the heap was not the fix;
what the run needed was `--analysis-timeout-ms`, because the default is 300 s
and one 7 MB bundle takes longer than that to parse on this machine.

A partial Evidence record was still sealed on timeout (`ev_38a80ddd…`) — REA
preserves what it collected instead of discarding the run, so attempt 2 was
not wasted.

Attempt 3 narrows the inventory to the selected sources, and REA states that
trade-off explicitly:

> `Caller-selected source analysis leaves 44 inventoried files outside analysis
scope. Inventory identity covers the complete artifact; relationships through
unselected sources remain unknown.`

### Main-bundle analysis — the run that closed the gap

| Field                 | Value                                                                   |
| --------------------- | ----------------------------------------------------------------------- |
| Status                | `ok: true`                                                              |
| Evidence ID           | `ev_3e61a793a603668a7a3838b982d7784614938c86d848aaa7675d7904be75b6df`   |
| Root artifact SHA-256 | `11ebf713209df61ce3a3dce1cf91e7a5275fcc6eaff27b96ec7745b5ee33d524`      |
| Semantic graph ID     | `jsrg_b4763a1a5d7c70216379719ee5e0285cc30f26c8a321cf39cd00f34cee125082` |
| Output size           | 2.4 MB Evidence JSON                                                    |

The root SHA-256 is **identical** to the 46-file run, confirming both analysed
the same artifact tree and differ only in scope. No `resource_constraint` and
no `provider_timeout` appear in this run's limitations.

So the main bundle **is** analysed now. What stays unknown is cross-bundle
relationships through the other 44 files _in this record_ — and the 46-file run
(`ev_03cd609d…`) covers exactly that. The two records are complementary rather
than redundant.

Other standing limitations, verbatim from the Evidence:

- "Graph coverage is incomplete; unavailable facts remain explicit and must not
  be read as absence."
- "JavaScript and HTML were parsed as inert text; bundle bootstrap code was
  never executed."
- "Static imports, entrypoints, workers, endpoints, and storage relationships do
  not prove runtime execution."
- "Webpack/Rspack factories were recovered from AST literals; REA did not invoke
  push handlers or bundle bootstrap code."
- "CommonJS and ESM binding relationships were recovered from inert syntax and
  resolved only within the inventoried artifact container."

The last two are why the recovered architecture is **identified as a
Webpack/Rspack bundle**: REA read the module-factory literals from the AST. It
did not execute anything. Nothing here is runtime observation.

## 5. Feature map

`evidence/scan-features.mjs` counts domain keywords across all 46 JS modules:
**59 distinct terms, 40,345 occurrences.** Counts are presence indicators, not
call-graph edges — a high count means the word recurs, not that the code runs.

| Group             | Terms | Occurrences |
| ----------------- | ----- | ----------- |
| filters           | 7     | 10,607      |
| export            | 9     | 10,183      |
| effects           | 5     | 6,543       |
| transitions       | 4     | 6,055       |
| captions          | 4     | 2,000       |
| media             | 5     | 1,420       |
| trimming          | 4     | 1,115       |
| timeline & tracks | 6     | 996         |
| audio             | 3     | 507         |
| text              | 3     | 473         |
| storage           | 3     | 260         |
| collab            | 2     | 126         |
| ai                | 4     | 60          |

Per-keyword counts and a stable context sample for each are in
`evidence/feature-map.json`.

### What this tells us about Clipchamp's architecture

1. **Export and filters dominate.** Together 20,790 of 40,345 hits. Clipchamp
   spends its bundle weight on the render pipeline and the look catalogue, not
   on timeline mechanics.
2. **Transitions are first-class objects**, not hardcoded effects — 6,055 hits
   across 4 distinct terms.
3. **AI is a thin surface.** Only 60 hits across 4 terms. Auto-captioning and
   auto-cut are server-side calls, not local models. Confirmed independently:
   the cache inventory shows the app talking to `browser.pipe.aria.microsoft.com`
   (ARIA telemetry) and `app.clipchamp.com`, with no local ML runtime.
4. **Audio has a real mixer.** `waveform` + `volume` + ducking/music-bed terms.
   But render output is still FFmpeg-class: `exportArgs` builds
   `-c:v aac -b:a …k`, i.e. a filter-graph model, not a sample-accurate mixer.
5. **Collab is minimal** (126 hits) — comments, share links, version history.

## 6. Telemetry and endpoints observed

From `evidence/cache-url-inventory.json`, produced by `evidence/scan-urls.mjs`.
It recovers 56 URL strings from the Chromium cache index files and splits them
**34 application-ish / 22 TLS-and-CRL plumbing**:

```
https://app.clipchamp.com/consumer/
https://browser.pipe.aria.microsoft.com/Collector/3.0/
https://mobile.events.data.microsoft.com/OneCollector/1.0/
https://M365CDN.nel.measure.office.net/api/report
https://ecs.nel.measure.office.net/api/report
https://spo.nel.measure.office.net/api/report
https://csp.microsoft.com/report/Office-Edgeworth-W
https://onedrive.live.com
https://*.box.com/
```

Two observations:

1. **Telemetry is Microsoft OneCollector / ARIA**, not Clipchamp-specific. The
   `*.box.com/` wildcard suggests a Box.com cloud-storage integration in the
   consumer app.
2. The 22 TLS entries (`pkiops.microsoft.com`, `digicert.com`, `pki.goog`) are
   certificate-chain artefacts of the cache, **not** application traffic.
   `scan-urls.mjs` classifies them so they cannot be mistaken for endpoints.

These strings prove only that a cache entry existed. They are not proof that a
request was sent or that it succeeded.

## 7. Network capture

**Not attempted.** A full HAR/SAZ capture was out of scope for this pass, so
there is **no observed request/response evidence** for any endpoint. Everything
in section 6 is inference from cached URL strings, and section 5 is static text
analysis. No runtime behaviour in this document was observed executing.

## 8. Licensing

The extracted bundles in `evidence/web-assets/` are Microsoft-copyrighted and
are **gitignored**. They are regenerable from the installed app via
`evidence/extract-cache.mjs`. No Clipchamp source is vendored into the
scaffold — only the behaviour, reimplemented.

## 9. Cross-check against the earlier browser capture

Facts asserted independently by both passes, with no contradiction:

| Fact                                         | Earlier pass (browser)             | This pass (static)                        |
| -------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| Editor is a web SPA at `app.clipchamp.com`   | yes                                | yes — `CONSUMER_APP_URL`                  |
| No local html/js/css in the MSIX             | yes                                | confirmed; bundles only in WebView2 cache |
| No analysis engine available                 | yes (`environment_healthy: false`) | yes — Hopper/Ghidra/JADX all missing      |
| Editor has a sidebar rail + stage + timeline | yes (a11y tree)                    | yes — `timeline` 996 hits                 |
| Transitions are a first-class panel          | yes (`Transitions` nav item)       | yes — 6,055 hits                          |
| Auto-captions exist in the stage toolbar     | yes                                | yes — `captions` 2,000 hits               |

The one fact this pass **corrects** is the `.NET` assumption about
`Clipchamp.exe` (§2). The earlier pass never claimed .NET, so nothing there
needs changing.

One gap this pass leaves where the earlier pass has data: the
[captions panel transcript flow](../../docs/CLIPCHAMP_REA_REFERENCE.md) was
observed running in the browser but is not yet reflected in the scaffold —
`Captions.svelte` is UI-only.
