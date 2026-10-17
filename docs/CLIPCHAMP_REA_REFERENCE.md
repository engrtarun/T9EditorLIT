# Clipchamp UI Reference — captured with REA

All evidence in this folder was produced by **REA** (`rea-agents@6.5.0`, `capture-browser-scenario`),
not by eyeballing or manual screenshots. Each run is a JSON Evidence envelope with `evidence_id`,
`limitations`, byte digests (sha256) and per-step artifacts.

## Runs

| Run               | Scenario                                                         | Result                                                               |
| ----------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `rea-run-01.json` | Start at `app.clipchamp.com`, 2 waits                            | login → home redirect, splash screen                                 |
| `rea-run-02.json` | `/consumer/home`, 14 s of waits                                  | **Home screen**: screenshot + full a11y tree                         |
| `rea-run-03.json` | click `Create a new video` (role locator)                        | **Editor opened** (`/consumer/editor/?driveId=…`), screenshot + a11y |
| `rea-run-04.json` | editor → click tabs `Text`, `Record & create`, `Content library` | 3 panel screenshots + a11y trees                                     |
| `rea-run-05.json` | editor, capture `dom` at end                                     | 387 KB DOM → design tokens                                           |

Screenshots: `rea-0*-step*.png` · a11y trees: `rea-0*-step*.a11y.txt` · DOM: `rea-05-editor.dom.html`

## Layout — Home (`rea-02-step2-wait2.png`)

- Top bar (48 px): app-waffle · Clipchamp logo+wordmark · centered search (`Search templates`) ·
  Buy Microsoft 365 · feedback · settings · help · avatar
- Left nav (248 px): tabs **Home**, **Templates**; bottom card = cloud storage
  (`1.50 GB used of 5 GB (28%)` + `Get more storage` + `Install desktop app`)
- Main: `h1 "Good to see you again"` → two gradient CTAs
  (`Create a new video / Start from scratch`, `Create a video with AI / Quickly auto compose…`) →
  `Get started with these easy edits` (Record yourself, Text to speech cards with `Try it`) →
  `Get inspired with a template` horizontal category tablist → `Your videos` project grid

## Layout — Editor (`rea-03-step4-editor_settle.png`, a11y 54 lines)

Regions exactly as the a11y tree names them:

1. **Top bar** — project title `Video Project 3 ▾` (rename), cloud-backup status, Share, Export (disabled until media exists)
2. **`navigation "Sidebar navigation"`** (56 px icon rail, labels under icons):
   `My media` [selected] · `Record & create` · `Content library` · `Templates` · `Text` · `Transitions`
   Selected tab = white pill, purple left indicator bar
3. **`region "Content sidebar"`** (248 px) — title + `Collapse toolbar` button, `tabpanel`,
   `separator "Resize panel"` on the right edge (draggable)
4. **`region "Stage"`** — undo/redo (`ctrl+z` / `ctrl+y`) top-left, centered floating toolbar
   (`Size` aspect-ratio dropdown, background color, autocaptions), black 16:9 stage canvas,
   transport row below: seek-to-start, −5 s, **Play `SPACE`**, time input `0:00.00 / 0:00.00`
5. **`region "Timeline"`** — transport toolbar, then the track grid; empty state text
   `Drag & drop media here`; a dashed drop target sits over it

### Sidebar panels (from `rea-04-*.png`)

- **My media**: purple `Import media ▾` button, dashed drop zone — `Drag & drop media from your device to import` / `Videos, audio, images, GIFs`
- **Text**: sections `Plain text` (Text tile), `Text styles` (`See all ›`: Creator, Text box, Pride, Button, Bubble, Retro), `Title` (Typewriter, Circular, Groovy, Fireworks…) — tiles are drag-to-timeline
- **Record & create**: `Record` → purple-gradient tiles `Screen and camera`, `Camera`, `Screen`, `Audio`; `Create` → blue-gradient tile `Text to speech`
- **Content library**: search box + filter, chips `All / Audio / Visuals`, `Featured` cards
  (`Shapes 227 items`, `Red 50 items`, `Curve 48 items`), `All content` (`Music`, `Annotations`…)

## Design tokens (extracted from `rea-05-editor.dom.html`)

- **Font**: `SegoeUI-Regular-final, Segoe UI` body; `SegoeUI-SemiBold-final` for headings/buttons
- **Brand purple ramp**: `#7611f0` `#9136f2` `#974cff` `#a966ff` `#b76aff` `#bc7fff` `#de67fd` · light tints `#ecb4ff`
- **Neutrals (Fluent)**: `#faf9f8` `#f3f2f1` `#f4f4f4` `#edebe9` `#e1dfdd` `#dcdcdc` `#bebbb8`
  `#959595` `#605e5c` `#484644` `#3b3b3b` `#252423` `#000000` `#ffffff`
- **Semantic Fluent vars in use**: `--colorNeutralForeground1`,
  `--colorNeutralForeground3`, `--colorNeutralForegroundInverted`, `--colorNeutralSurface3`,
  `--colorSubtleBackgroundHover`
- **Radii**: `2px` `3px` `4px` `9px` `16px`, circles `50%`

## How the runs were driven (for replay)

```powershell
rea capture-browser-scenario docs\clipchamp-ref\rea-scenario-0N.json --format json > docs\clipchamp-ref\rea-run-0N.json
```

Scenario JSON shape (schema source: `rea-agents/dist/domain/browserScenarioValues.js`):

```jsonc
{
  "browser": {
    "mode": "launch",
    "executable_path": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  },
  "start_url": { "url": "https://app.clipchamp.com/consumer/home", "query": [] },
  "environment": {
    "viewport": { "width": 1600, "height": 900, "device_scale_factor": 1 },
    "color_scheme": "light",
  },
  "actions": [
    { "step_id": "…", "action": "wait_for_timeout", "duration_ms": 9000 },
    {
      "step_id": "…",
      "action": "click",
      "locator": { "kind": "role", "role": "button", "name": "Create a new video" },
      "timeout_ms": 15000,
    },
    // also: goto / fill / press / select_option / check / uncheck / wait_for
    // locator kinds: role | css | test_id
  ],
  "capture": {
    "after_each_step": ["screenshot", "accessibility", "url"],
    "at_end": ["dom", "url"],
  },
}
```

Notes / dead ends kept for honesty:

- `capture-native-ui-scenario` (driving the installed desktop app) is **unavailable** — it is a
  native-provider tool and no analysis engine (Hopper/Ghidra/IDA) is installed
  (`rea doctor` → `environment_healthy: false`, remediation = install Ghidra 12.1.x).
- Launching `Clipchamp.exe` with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
  did **not** expose a CDP endpoint (60 s of probes, `CDP NOT EXPOSED`), so `list-browser-targets` /
  `inspect-web-page` against the desktop app was not possible.
- PowerShell eats embedded `"` when passing `--steps '[{"kind":…}]'`; backslash-escape (`\"`) is required.
- The web app is a full SPA: `CONSUMER_APP_URL=https://app.clipchamp.com` (from the package's
  `appsettings.json`); the MSIX install dir contains **no** html/js/css assets.
