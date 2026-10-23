import type { Plugin } from 'vite';

/**
 * INTERFACE TEXT SIZE — the build-time half of it.
 *
 * The app's type is set in px everywhere (`text-[13px]` and friends), so
 * changing the root font-size would do nothing, and zooming the whole webview
 * would do too much: every `clientX - rect.left` in the timeline would suddenly
 * be in a different unit than the `px`-per-second zoom it is divided by, and a
 * click on the ruler would seek 10 % off. Text size must scale **text** and
 * nothing else.
 *
 * So the numbers get rewritten once, here, instead of in four hundred places:
 *
 *     font-size: 13px      ->  font-size: calc(13px * var(--t9-text-scale, 1))
 *     --text-sm: 0.875rem  ->  --text-sm: calc(0.875rem * var(--t9-text-scale, 1))
 *
 * The variable itself lives on `:root` (app.css) and the appearance store only
 * ever changes the number: 0.9 / 1 / 1.15 for Small / Default / Large. One
 * write, the whole interface re-typesets, layout reflows around the wider text,
 * and no coordinate system anywhere in the codebase learns a new unit.
 *
 * Notes:
 *   · `line-height` in the same rule scales too, so a preset size never lands
 *     in a line box that is too short for it;
 *   · unitless line-heights (`line-height: 1.5`) are ratios — they already
 *     follow the font, and are left alone;
 *   · the rewrite is not idempotent-proof by accident: the pattern only
 *     matches a bare number right after the colon, so a second pass over
 *     `calc(...)` matches nothing;
 *   · no dependency, ~30 lines, and it runs in dev and in `vite build` alike.
 */

/** Literal sizes: `font-size: 13px`, `line-height: 1.25rem`. */
const DECL = /(font-size|line-height)(\s*:\s*)(-?[\d.]+)(px|rem)/g;

/** The theme's font-size scale: `--text-sm`, `--text-base--line-height`. */
const THEME = /(--text-[a-z0-9][a-z0-9-]*)(\s*:\s*)(-?[\d.]+)(px|rem)/g;

const SCALE = 'calc($3$4$2* var(--t9-text-scale, 1))';

export function textScale(): Plugin {
  return {
    name: 't9-text-scale',
    enforce: 'post',
    transform(code) {
      if (!code.includes('font-size') && !code.includes('--text-')) return null;
      const out = code.replace(DECL, SCALE).replace(THEME, SCALE);
      // `null` when nothing matched keeps the module (and its map) untouched.
      return out === code ? null : { code: out, map: null };
    }
  };
}
