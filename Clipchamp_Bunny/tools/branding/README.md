# Branding — the board is the source of truth

Everything visual about T9 Editor LIT comes from one file:

```
Clipchamp_Bunny/T9 Editor LIT Branding Board.png
```

It has the colour palette, the primary logo, the app icon, the alternative
versions, and a DO / DON'T list. This folder holds the **tools** that turn
that board into what the app and the desktop actually show.

## The rules, and where they are enforced

| Board rule | How it is enforced |
| --- | --- |
| "Use original, high-quality assets" | The mark is **traced** from the board's own pixels, never redrawn. |
| "Don't stretch or distort the logo" | The SVG keeps the artwork's own viewBox. |
| "Don't add effects (glow, shadows, etc.)" | The mark is a flat path with a gradient. Nothing is layered on top. |
| "Don't change the colours" | The gradient stops are the board's palette. |
| "Don't use low-resolution versions" | The trace runs at 344 px from a 600 px source, and the app icons come from the 336 px board app icon. |
| "Don't add extra elements or text" | The mark is the mark. No letters, no badge, no frame. |

## The tools

| File | What it does |
| --- | --- |
| `trace-mark.mjs` | Traces the mark out of `logo-full.png` and writes `src/lib/components/dashboard/BrandMark.svelte` and `BrandMarkMono.svelte`. |
| `png.mjs` | A tiny PNG writer and polygon rasteriser (Node has zlib; a PNG is a zlib stream in a wrapper). |
| `preview-mark.mjs` | Paints the generated component's path, so the mark can be looked at without a browser. |

## Why a trace and not a hand-written SVG

The board's logo is a *sculpted* mark: a T cut on a diagonal, a "9" whose
bowl is a ring with a play button in it, a ruler-shaped leg and a vertical
light beam. A hand-written SVG can only ever be an approximation, and the
board's first rule is "use original, high-quality assets".

So the tooling reads the original pixels and follows the outline. The trace
has a **quality gate**: it compares its own output against the source
artwork, pixel for pixel, and fails when the interior does not match. A
brand mark that has quietly drifted is worse than one that was never
generated.

The tracer also runs a **self test** on shapes with a known answer - a disc,
an annulus, a ring with an island in it, two bars - so a broken contouring
routine is caught before it ever touches the logo.

## Regenerating the mark

```powershell
cd Clipchamp_Bunny
node tools\branding\trace-mark.mjs
```

That writes:

- `src/lib/components/dashboard/BrandMark.svelte` - the app's mark
- `src/lib/components/dashboard/BrandMarkMono.svelte` - the same mark in one
  colour, for when the board's "monochrome version" is what is needed
- `tools/branding/out/t9-mark.svg` - the mark on its own
- `tools/branding/out/t9-mark-preview.png` - what it looks like
- `tools/branding/out/t9-mark-diff.png` - red = missed, blue = invented

`BrandMark.svelte` is generated: **do not hand-edit it**. It is in
`.prettierignore` for the same reason.

## The app icons

The Windows icons come from the board's app icon:

```powershell
cd Clipchamp_Bunny
npx tauri icon tools\branding\app-icon.png
```

That regenerates `src-tauri/icons/` (32, 64, 128, 256, the `.ico`, the
`.icns`, and the Windows Store logos).

The web favicons are the same artwork at the sizes a browser asks for:

```powershell
cd Clipchamp_Bunny
ffmpeg -i tools\branding\app-icon.png -vf scale=32:32:flags=lanczos -frames:v 1 -update 1 public\favicon-32.png
ffmpeg -i tools\branding\app-icon.png -vf scale=48:48:flags=lanczos -frames:v 1 -update 1 public\favicon.png
ffmpeg -i tools\branding\app-icon.png -vf scale=180:180:flags=lanczos -frames:v 1 -update 1 public\apple-touch-icon.png
```

`index.html` points at all three.

## The wordmark

The board sets "T9 Editor" in a wide, squarish techno face with flat
terminals. `Agency FB` is the closest face Windows ships, so the app uses
it through the `--font-brand` token - no font file to download, no licence
question, no extra RAM.

## The colours

| Token | Value | Board |
| --- | --- | --- |
| `--color-nc-brand` | `#4D8DFF` | Primary Blue |
| `--color-nc-txt` | `#F5F7FA` | Text / Light |
| `--color-nc-bg` | `#15171B` | Background |

`nc-gold` is kept as an alias for the old name only. A token that lies
about its colour is how branding drifts.
