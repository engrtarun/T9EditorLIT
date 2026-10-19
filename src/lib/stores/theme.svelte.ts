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
 * `t9-theme` is read before first paint by static/theme-init.js; this store
 * is the writer, and it applies the attribute immediately on construction
 * so a theme set mid-session takes effect without waiting for an effect.
 */

export type ThemeId = "clipchamp" | "nanami" | "clipchamp-light";

/** Cycles in this order when the toggle button is pressed. */
const ORDER: readonly ThemeId[] = ["clipchamp", "nanami", "clipchamp-light"];

const STORAGE_KEY = "t9-theme";

export const THEME_LABEL: Record<ThemeId, string> = {
  clipchamp: "Clipchamp dark",
  nanami: "Nanami",
  "clipchamp-light": "Clipchamp light",
};

function isTheme(value: string | null): value is ThemeId {
  return value !== null && (ORDER as readonly string[]).includes(value);
}

function readStored(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
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
    const index = ORDER.indexOf(this.current);
    this.apply(ORDER[(index + 1) % ORDER.length]);
  }

  get next(): ThemeId {
    const index = ORDER.indexOf(this.current);
    return ORDER[(index + 1) % ORDER.length];
  }
}

export const theme = new ThemeStore();
