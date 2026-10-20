/**
 * Theme switch for the Clipchamp shell.
 *
 * Three palettes share ONE token namespace (`--color-cc-*`, see app.css);
 * switching only rewrites `<html data-theme>`, so no component knows which
 * theme is up and nothing needs to re-render — the cascade does the work.
 *
 *   clipchamp       Clipchamp dark        (default)
 *   nanami          charcoal + rose/gold  (T9's own look)
 *   clipchamp-light the shipped app's real light tokens
 *
 * The names, labels and cycle order live in `lib/themes.ts` so the top-bar
 * toggle, the Settings picker and the allow-list can never drift apart.
 *
 * `t9-theme` is read before first paint by static/theme-init.js; this store
 * is the writer, and it applies the attribute immediately on construction
 * so a theme set mid-session takes effect without waiting for an effect.
 */

import { isThemeId, nextThemeId, type ThemeId } from "../themes";

export { THEME_HINT, THEME_LABEL, THEMES } from "../themes";
export type { ThemeId } from "../themes";

const STORAGE_KEY = "t9-theme";

function readStored(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(stored)) return stored;
  } catch {
    // Storage unavailable (private mode) — fall through to the default.
  }
  return "clipchamp";
}

class ThemeStore {
  current = $state<ThemeId>("clipchamp");

  constructor() {
    this.apply(readStored());
  }

  private apply(id: ThemeId): void {
    this.current = id;
    document.documentElement.setAttribute("data-theme", id);
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", id === "clipchamp-light" ? "light" : "dark");
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Persisting is best-effort; the in-session switch still works.
    }
  }

  set(id: ThemeId): void {
    if (id === this.current) return;
    this.apply(id);
  }

  /** Next palette in the cycle — also what the toggle button's tooltip shows. */
  toggle(): void {
    this.apply(nextThemeId(this.current));
  }

  get next(): ThemeId {
    return nextThemeId(this.current);
  }
}

export const theme = new ThemeStore();
