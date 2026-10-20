<#
  Builds docs\THEME_LOGIC.ipynb — a single, self-contained notebook that
  documents T9EditorLIT's theme system (thoughts + screenshots + real code).

  Why a script instead of a hand-written .ipynb:
    1. The code cells are read straight out of the source files, so the
       notebook can never drift from the code it documents.
    2. Screenshots are embedded as base64 attachments, so the .ipynb is one
       portable file — no sibling folders to lose.
    3. JSON produced by ConvertTo-Json is always valid, and the code keeps its
       exact indentation (no manual quote-escaping).

  Run:  pwsh docs\theme-logic\build.ps1     (or powershell.exe — PS 5.1 ok)
  No Python anywhere in this repo (AGENTS.md §2); PowerShell does the job.
#>
$ErrorActionPreference = 'Stop'

$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
$REPO = (Resolve-Path (Join-Path $HERE '..\..')).Path

# ── Helpers ────────────────────────────────────────────────────────────────

function Read-Part {
  param([string]$Rel, [int]$From = 1, [int]$To = 0)
  # -Encoding UTF8 is mandatory: Windows PowerShell 5.1 otherwise reads the
  # file as ANSI and turns every em dash / box-drawing char into mojibake.
  $lines = @(Get-Content -LiteralPath (Join-Path $REPO $Rel) -Encoding UTF8)
  if ($To -le 0) { $To = $lines.Count }
  ($lines[($From - 1)..($To - 1)] -join "`n")
}

function To-Source {
  param([string]$Text)
  $raw = @($Text -split "`n")
  $out = for ($i = 0; $i -lt $raw.Count; $i++) {
    if ($i -lt $raw.Count - 1) { $raw[$i] + "`n" } else { $raw[$i] }
  }
  @($out)
}

$cells = New-Object System.Collections.ArrayList

function Add-Markdown {
  param([string]$Text)
  [void]$cells.Add(@{ cell_type = 'markdown'; metadata = @{}; source = (To-Source $Text) })
}

function Add-Code {
  param([string]$Text)
  [void]$cells.Add(@{
      cell_type       = 'code'
      execution_count = $null
      metadata        = @{}
      outputs         = @()
      source          = (To-Source $Text)
    })
}

function Add-Image {
  param([string]$File, [string]$Caption)
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $HERE $File)))
  [void]$cells.Add(@{
      cell_type    = 'markdown'
      metadata     = @{}
      attachments  = @{ $File = @{ 'image/png' = $b64 } }
      source       = (To-Source ("![{0}](attachment:{1})`n`n**{0}**" -f $Caption, $File))
    })
}

# ── 1. Title ───────────────────────────────────────────────────────────────

Add-Markdown @'
# T9EditorLIT — Theme System

**Clipchamp dark · Nanami · Clipchamp light** — one token namespace, three palettes, zero-re-render switching.

> Hinglish TL;DR: ek baar tokens likh do, phir sirf `<html data-theme="...">` badlo — poori app ka rang badal jaata hai, koi component dobara render nahi hota. Neeche thoughts, live screenshots aur copy-paste-ready code hai.

This notebook is **self-contained**: the screenshots are embedded as base64 attachments and the code cells are generated from the real source files by `docs/theme-logic/build.ps1`. Re-run that script after changing the theme and this document updates itself.

## What lives where

| Piece | File | Job |
| --- | --- | --- |
| Token definitions + 3 palettes | `src/app.css` | `@theme static` block + two unlayered `[data-theme=…]` overrides |
| Pre-paint restore | `static/theme-init.js` | Reads `localStorage` before first paint, sets `data-theme` |
| Runtime switch (writer) | `src/lib/stores/theme.svelte.ts` | Svelte 5 rune store: `set` / `toggle` / `next` |
| HTML shell | `src/app.html` | `<html class="dark" data-theme="clipchamp">` + `<meta color-scheme>` |
| Toggle UI | `src/lib/components/clipchamp/CcTopBar.svelte` | Moon/Sun button + `CcMenu` radio list |

## Requirements

- Svelte 5 (runes) + Tailwind CSS v4 — the `@theme static` block is v4 syntax.
- Works in a plain Vite SPA too; the SvelteKit-specific `%sveltekit.assets%` markers can be replaced with plain relative paths.
'@

# ── 2. Thoughts ────────────────────────────────────────────────────────────

Add-Markdown @'
## Thought process — why it is built this way

These are decisions, not accidents. Each one has a failure mode it exists to prevent.

1. **One namespace, values only swap.** Components are written against *names* (`--color-cc-surface`, `--color-cc-link`), never against hex codes. Adding a fourth theme means adding one CSS block and one array entry — zero component edits.

2. **Switch by attribute, not by state.** `document.documentElement.setAttribute("data-theme", …)` and the CSS cascade does the rest. No `if (theme === 'dark')` in markup, no re-render of a 3,000-node editor tree, no flash of the wrong palette mid-switch.

3. **`@theme static`, not `@theme`.** Tailwind v4 normally tree-shakes unused tokens. A token referenced only inside an `svg fill="var(--color-cc-purple)"` attribute is invisible to that scan, so the token never gets emitted and the fill silently disappears. `static` forces every token to be written out.

4. **Theme overrides are deliberately UNLAYERED.** Tailwind emits `@theme` into `@layer theme`, and an unlayered rule always outranks any layered one regardless of source order. That is what makes `[data-theme="nanami"]` reliably beat the base block on the same element — no `!important`, no specificity games, no source-order fragility.

5. **The purple ramp is role-based, not a gradient.** In a dark UI the *opposite* ordering from a light one is needed for the same jobs:
   - `purple` — brand accent: focus rings, rail indicator, borders. **Never** carries text.
   - `btn` / `btn-hover` — filled primary button; the contrast-checked version that clears 4.5:1 with white text.
   - `link` — accent **text** on a panel, the bright end of the ramp.
   - `lilac` / `blush` — decorative fills only.
6. **No flash on launch.** `static/theme-init.js` runs from `<head>` before the first paint, so a user who left it on Nanami never sees a dark-purple frame first. It is an **external** file because Tauri ships `script-src 'self'`, which forbids inline `<script>`.

7. **`color-scheme` is set twice, on purpose** — once in CSS (`html { color-scheme: dark }`) and once as a `<meta>` tag the init script rewrites. The meta is what steers the UA *before* CSS downloads; the CSS is the durable source. `.cc-shell` then re-declares `color-scheme: inherit`, because a stale `light` there was painting light scrollbars and form controls inside an otherwise dark build.

8. **Never trust `localStorage`.** The stored value is validated against an allow-list (`THEMES.indexOf(...)`); anything unknown — garbage, a removed theme from an older build, private-mode `null` — falls back to `clipchamp`. Both readers (init script and store) implement the same fallback.

9. **Dark is the default, light is a peer.** The target machine and the user's work are dark-first, so `clipchamp` is default. `clipchamp-light` is a full third palette with its own light-tuned `keep/cut/review` dims — not a "just invert it" afterthought.

10. **Contrast is checked per pairing, not per token.** Every text step is verified on the surface it actually sits on, and the `keep/cut/review` chips are checked as *pairs* (`--color-cc-keep` on `--color-cc-keep-dim`). That is why the dark dims are near-black instead of pastel — pastel dims are a light-theme device.

11. **Switch survives mode isolation.** The toggle lives in the always-mounted top bar, outside every `{#key}` block, so it survives the Home ⇄ Editor swap and the mode switch that destroys the rest of the tree.
'@

# ── 3. Screenshots ─────────────────────────────────────────────────────────

Add-Markdown '## The three palettes, live'
Add-Image 'theme-clipchamp-dark.png' 'data-theme="clipchamp" — default, Clipchamp dark'
Add-Image 'theme-nanami.png' 'data-theme="nanami" — charcoal + rose/gold'
Add-Image 'theme-clipchamp-light.png' 'data-theme="clipchamp-light" — shipped Fluent light tokens'

Add-Markdown @'
Same DOM, same component tree, same classes — the only difference between the three images is the value of one attribute on `<html>`.

## Token roles

| Token | Role | Light-theme note |
| --- | --- | --- |
| `--color-cc-bg` | App chrome background | `#121219` dark → `#f4f4f4` light |
| `--color-cc-sunken` | Recessed areas (timeline bed, rail) | one step darker than `bg` |
| `--color-cc-surface` | Panels and cards | dark `#1b1b25`, light `#ffffff` |
| `--color-cc-tint` | Hover / selected rows | sits between surface and menu |
| `--color-cc-menu` | Floating layers (menus, popovers) | one step *above* the panel |
| `--color-cc-line` / `-soft` | Hairlines, 1px borders | theme-matched greys |
| `--color-cc-text` … `-4` | Four text emphasis steps | all ≥ 4.5:1 on their own surface |
| `--color-cc-purple` | Accent: focus, indicator, border | never text |
| `--color-cc-btn` / `-hover` | Filled primary button | AA with white text |
| `--color-cc-link` | Accent text on a panel | bright end of the ramp |
| `--color-cc-lilac` / `-blush` | Decorative fills only | — |
| `--color-cc-keep` / `-cut` / `-review` | Transcript decisions | each checked against its `-dim` |
'@

# ── 4. Code: tokens ────────────────────────────────────────────────────────

Add-Markdown '## Code 1 of 5 — `src/app.css`: the tokens and the three palettes'
Add-Code (Read-Part 'src/app.css' 148 326)

Add-Markdown @'
## Code 2 of 5 — `src/app.html`: the shell

Note the `<html data-theme="clipchamp">` default. See the pitfalls section at the bottom for a very real bug this file once caused.
'@
Add-Code (Read-Part 'src/app.html')

Add-Markdown '## Code 3 of 5 — `static/theme-init.js`: restore before first paint'
Add-Code (Read-Part 'static/theme-init.js')

Add-Markdown '## Code 4 of 5 — `src/lib/stores/theme.svelte.ts`: the runtime switch'
Add-Code (Read-Part 'src/lib/stores/theme.svelte.ts')

Add-Markdown @'
## Code 5 of 5 — wiring a toggle into a component

Moon/Sun button + radio menu, from `CcTopBar.svelte`. Store access is just an import; there is no context provider and no dispatch.
'@
Add-Code (Read-Part 'src/lib/components/clipchamp/CcTopBar.svelte' 529 563)

Add-Markdown @'
Using the tokens in markup — this is the whole component-facing API:

```svelte
<div class="bg-cc-surface text-cc-text border-cc-line border">
  <a class="text-cc-link">Open</a>
  <button class="cc-btn-primary bg-cc-btn text-white">Export</button>
  <span class="bg-cc-keep-dim text-cc-keep">keep</span>
</div>
```

No component ever mentions a theme id. That is the point.
'@

# ── 5. Integration + pitfalls + verification ───────────────────────────────

Add-Markdown @'
## Dropping this into another project

1. Copy the `@theme static` block and the two `[data-theme=…]` overrides into your CSS entry point (Tailwind v4 required).
2. Put `<html class="dark" data-theme="clipchamp">` and `<meta name="color-scheme" content="dark">` in your HTML shell.
3. Drop `theme-init.js` into `static/` and load it from `<head>` — **not** deferred, not a module; it must beat the first paint.
4. Copy `theme.svelte.ts` and export `theme` + `THEME_LABEL`.
5. Add a toggle button that calls `theme.toggle()` or `theme.set(id)`.
6. Rewrite your components to use `cc-*` tokens only. Delete every raw hex you find — a raw hex is a theme that will not switch.
7. Verify (see below).

## Pitfalls — bugs we actually hit, so you don't have to

- **Never write `%sveltekit.body%` (or any `%sveltekit.*%`) inside `src/app.html`, even in a comment.** The dev transform replaces the *first* occurrence in the file. Ours was inside an HTML comment describing this very theme script, so the client boot script got injected into the comment, the real body placeholder never rendered, and the app came up as a black screen with **zero console errors**. Symptom to remember: `document.body.innerText` is empty and the only DOM is a literal `%sveltekit.body%`.
- **Inline `<script>` is blocked in the Tauri shell** (`script-src 'self'`). Any pre-hydration logic has to be a separate file in `static/`.
- **`getCurrentWebview()` throws outside Tauri.** Running `vite dev` in a plain browser means `"__TAURI_INTERNALS__" in window` is false — guard it, or one uncaught `TypeError` takes down the whole `$effect` that registered your drop listener.
- **Keep the theme code out of `{#key}` blocks.** Mode isolation destroys and rebuilds that subtree; a store defined inside it would be recreated (and re-read `localStorage`) on every switch.
- **`.ipynb` breaks `prettier --check .`** with `No parser could be inferred`. `*.ipynb` is listed in `.prettierignore` for that reason — keep it there or CI goes red on a documentation file.

## Verification (CI/CD)

```powershell
npm run verify:fast   # prettier + svelte-check + node --test + cargo check
```

Last run: **exit 0** — prettier clean, svelte-check 0 errors / 0 warnings, 14/14 node tests, `cargo check` clean (4 pre-existing dead-code warnings only).

Python is banned repo-wide (AGENTS.md §2), which is also why this notebook is built by PowerShell rather than by a `nbformat` script.
'@

# ── Assemble ───────────────────────────────────────────────────────────────

$notebook = @{
  cells         = @($cells)
  metadata      = @{
    title       = 'T9EditorLIT — Theme System (Clipchamp dark / Nanami / Clipchamp light)'
    description = 'Thoughts, screenshots and copy-paste-ready code for the T9EditorLIT theme system. Generated by docs/theme-logic/build.ps1.'
    kernelspec  = @{
      display_name = 'TypeScript'
      language     = 'typescript'
      name         = 'typescript'
    }
    language_info = @{
      name         = 'typescript'
      file_extension = '.ts'
      mimetype     = 'text/typescript'
    }
  }
  nbformat      = 4
  nbformat_minor = 5
}

$out = Join-Path $REPO 'docs\THEME_LOGIC.ipynb'
$json = ConvertTo-Json -InputObject $notebook -Depth 30
[IO.File]::WriteAllText($out, $json, [Text.UTF8Encoding]::new($false))

$kb = [Math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host "Wrote $out ($kb KB, $($cells.Count) cells)"
