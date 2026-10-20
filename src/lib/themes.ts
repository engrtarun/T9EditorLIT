/**
 * Theme vocabulary — the pure half of the theme system.
 *
 * Kept out of `stores/theme.svelte.ts` so it can be unit-tested with
 * `node --test` (the store needs Svelte's runes to exist, plain Node
 * does not have them) and so the labels have somewhere to live that is
 * not a component.
 *
 * The matching colours live in `src/app.css` under one token namespace
 * (`--color-cc-*`); this file only knows the NAMES. Switching a theme
 * rewrites `<html data-theme>` and the cascade does the rest, so no
 * component ever mentions a colour.
 */

export type ThemeId = "clipchamp" | "nanami" | "clipchamp-light";

/**
 * Every palette, in display order.
 *
 * The single list a new theme has to join: the toggle button cycles it,
 * the Settings picker renders it, and the allow-list below validates
 * against it. Adding a theme means adding one CSS block and one entry
 * here — zero component edits.
 */
export const THEMES: readonly ThemeId[] = ["clipchamp", "nanami", "clipchamp-light"];

/** Name shown in the top-bar menu and the Settings picker. */
export const THEME_LABEL: Record<ThemeId, string> = {
  clipchamp: "Clipchamp dark",
  nanami: "Nanami",
  "clipchamp-light": "Clipchamp light",
};

/** One line per palette, shown under its name in the Settings picker. */
export const THEME_HINT: Record<ThemeId, string> = {
  clipchamp: "The default dark Clipchamp chrome.",
  nanami: "Charcoal with rose & gold accents.",
  "clipchamp-light": "The shipped app's own light tokens.",
};

/**
 * Whether a stored value names a palette we actually ship.
 *
 * `localStorage` is never trusted: garbage, a theme removed in a later
 * build, and private-mode `null` all have to fall back to the default
 * rather than paint the app with an unknown palette.
 */
export function isThemeId(value: string | null): value is ThemeId {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

/**
 * The palette after `current` in the cycle.
 *
 * This is what the top-bar toggle button switches to, and what its
 * tooltip promises — one function, so the button and the tooltip can
 * never disagree.
 */
export function nextThemeId(current: ThemeId): ThemeId {
  const index = THEMES.indexOf(current);
  return THEMES[(index + 1) % THEMES.length];
}
