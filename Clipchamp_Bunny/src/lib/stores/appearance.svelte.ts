/**
 * How the interface *looks* — six independent choices, all of them local.
 *
 * Everything is applied as CSS custom properties and data-attributes on
 * `<html>`, never by re-rendering components: `bg-nc-brand` compiles to
 * `var(--color-nc-brand)` in Tailwind 4, so re-declaring that variable on the
 * root element repaints buttons, selections, highlights and the focus ring in
 * one write. Same story for the panel colours. That is what makes every change
 * take effect instantly and without a restart.
 *
 * The values live in `localStorage` (`t9-editor-lit.appearance`), like the
 * other per-machine choices in this codebase — no database for six strings.
 *
 * Two rules the presets must keep:
 *   · the default is T9 Editor LIT's premium-dark look exactly as it was,
 *   · nothing here ever touches the background video — panel appearance is a
 *     foreground setting, and the footage is never blurred, tinted or filtered.
 */

const STORAGE_KEY = 't9-editor-lit.appearance';

/* ------------------------------------------------------------------ accents */

export type AccentId = 'blue' | 'violet' | 'cyan' | 'emerald' | 'amber' | 'rose';

export interface Accent {
  id: AccentId;
  /** `--color-nc-brand`: buttons, selections, highlights, focus ring. */
  brand: string;
  /** `--color-nc-brand-dim`: gradients and the dimmer states of the same hue. */
  dim: string;
}

/** Small, coordinated set — the first entry is the brand board's blue. */
export const ACCENTS: Accent[] = [
  { id: 'blue', brand: '#4d8dff', dim: '#2f5fc0' },
  { id: 'violet', brand: '#8b7dff', dim: '#5b4fd6' },
  { id: 'cyan', brand: '#2fd0e8', dim: '#1a8ba3' },
  { id: 'emerald', brand: '#34d399', dim: '#17855c' },
  { id: 'amber', brand: '#f5a524', dim: '#a86c07' },
  { id: 'rose', brand: '#ff6b8b', dim: '#c33a56' }
];

/* --------------------------------------------------------------- typography */

export type TypographyId = 'clean' | 'cinematic' | 'gaming';

/**
 * Headings only. Body text keeps the system face in every preset, so a
 * decorative font is never applied to the whole app — readability is not
 * something a preset is allowed to spend.
 *
 * All three faces ship with Windows: no font file, no download, no licence.
 */
const HEADING_FONT: Record<TypographyId, string> = {
  clean: "'Segoe UI', system-ui, -apple-system, Roboto, Arial, sans-serif",
  cinematic: "Georgia, 'Times New Roman', 'Segoe UI', serif",
  gaming: "'Bahnschrift', 'Agency FB', 'Segoe UI', system-ui, sans-serif"
};

/* --------------------------------------------------------------- text scale */

export type TextSizeId = 'sm' | 'md' | 'lg';

/**
 * The multiplier for every literal `font-size`/`line-height` in the
 * stylesheet — applied by `tools/text-scale-plugin.ts` at build time as
 * `calc(13px * var(--t9-text-scale, 1))`.
 *
 * The alternative, zooming the whole webview, was rejected on purpose: the
 * timeline measures `clientX - rect.left` in viewport pixels and divides it by
 * a px-per-second zoom, so a global zoom would make every seek and trim land
 * ~10 % off. Scaling text alone reflows layout around the wider glyphs and
 * teaches no coordinate system a new unit.
 */
const TEXT_SCALE: Record<TextSizeId, string> = {
  sm: '0.9',
  md: '1',
  lg: '1.15'
};

/* ---------------------------------------------------- panels, density, motion */

export type PanelId = 'solid' | 'translucent' | 'minimal';
export type DensityId = 'comfortable' | 'compact';
export type MotionId = 'standard' | 'reduced';

/** Panel opacities — colour only. No backdrop blur: the video stays sharp. */
const PANEL_FILL: Record<PanelId, { panel: string; panel2: string }> = {
  solid: { panel: '', panel2: '' }, // '' = fall back to the theme default
  translucent: { panel: 'rgb(26 29 36 / 0.74)', panel2: 'rgb(33 37 48 / 0.76)' },
  minimal: { panel: 'rgb(26 29 36 / 0.42)', panel2: 'rgb(33 37 48 / 0.52)' }
};

export interface Appearance {
  accent: AccentId;
  typography: TypographyId;
  textSize: TextSizeId;
  density: DensityId;
  panels: PanelId;
  motion: MotionId;
}

export const APPEARANCE_DEFAULTS: Appearance = {
  accent: 'blue',
  typography: 'clean',
  textSize: 'md',
  density: 'comfortable',
  panels: 'solid',
  motion: 'standard'
};

const accentOf = (id: AccentId): Accent => ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];

function coerce(raw: unknown): Appearance {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
    typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;
  return {
    accent: oneOf(
      o.accent,
      ACCENTS.map((a) => a.id),
      APPEARANCE_DEFAULTS.accent
    ),
    typography: oneOf(
      o.typography,
      ['clean', 'cinematic', 'gaming'] as const,
      APPEARANCE_DEFAULTS.typography
    ),
    textSize: oneOf(o.textSize, ['sm', 'md', 'lg'] as const, APPEARANCE_DEFAULTS.textSize),
    density: oneOf(o.density, ['comfortable', 'compact'] as const, APPEARANCE_DEFAULTS.density),
    panels: oneOf(
      o.panels,
      ['solid', 'translucent', 'minimal'] as const,
      APPEARANCE_DEFAULTS.panels
    ),
    motion: oneOf(o.motion, ['standard', 'reduced'] as const, APPEARANCE_DEFAULTS.motion)
  };
}

class AppearanceStore {
  accent = $state<AccentId>(APPEARANCE_DEFAULTS.accent);
  typography = $state<TypographyId>(APPEARANCE_DEFAULTS.typography);
  textSize = $state<TextSizeId>(APPEARANCE_DEFAULTS.textSize);
  density = $state<DensityId>(APPEARANCE_DEFAULTS.density);
  panels = $state<PanelId>(APPEARANCE_DEFAULTS.panels);
  motion = $state<MotionId>(APPEARANCE_DEFAULTS.motion);

  /** The brand colour currently in use — handy for the settings swatches. */
  get brand(): string {
    return accentOf(this.accent).brand;
  }

  set<K extends keyof Appearance>(key: K, value: Appearance[K]): void {
    if (this[key] === value) return;
    // The store's fields are `$state`, so a plain cast keeps them writable
    // without widening the public type of `set`.
    (this as unknown as Record<K, Appearance[K]>)[key] = value;
    this.apply();
    this.persist();
  }

  /** One write to `<html>`, and every token-derived colour follows. */
  private apply(): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const accent = accentOf(this.accent);

    root.style.setProperty('--color-nc-brand', accent.brand);
    root.style.setProperty('--color-nc-brand-dim', accent.dim);
    // The legacy `nc-gold` token is an alias of the brand blue; leaving it
    // behind after an accent change would make the two disagree about a colour.
    root.style.setProperty('--color-nc-gold', accent.brand);
    root.style.setProperty('--color-nc-gold-dim', accent.dim);

    root.style.setProperty('--font-heading', HEADING_FONT[this.typography]);
    root.style.setProperty('--t9-text-scale', TEXT_SCALE[this.textSize]);

    const fill = PANEL_FILL[this.panels];
    if (fill.panel) {
      root.style.setProperty('--color-nc-panel', fill.panel);
      root.style.setProperty('--color-nc-panel-2', fill.panel2);
    } else {
      root.style.removeProperty('--color-nc-panel');
      root.style.removeProperty('--color-nc-panel-2');
    }

    root.dataset.density = this.density;
    root.dataset.motion = this.motion;
    root.dataset.panels = this.panels;
    root.dataset.textsize = this.textSize;
  }

  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          accent: this.accent,
          typography: this.typography,
          textSize: this.textSize,
          density: this.density,
          panels: this.panels,
          motion: this.motion
        })
      );
    } catch {
      /* private mode */
    }
  }

  /** Back to the T9 defaults — the look the app shipped with. */
  reset(): void {
    this.accent = APPEARANCE_DEFAULTS.accent;
    this.typography = APPEARANCE_DEFAULTS.typography;
    this.textSize = APPEARANCE_DEFAULTS.textSize;
    this.density = APPEARANCE_DEFAULTS.density;
    this.panels = APPEARANCE_DEFAULTS.panels;
    this.motion = APPEARANCE_DEFAULTS.motion;
    this.apply();
    this.persist();
  }

  constructor() {
    let saved: unknown = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      /* private mode */
    }
    const v = coerce(saved);
    this.accent = v.accent;
    this.typography = v.typography;
    this.textSize = v.textSize;
    this.density = v.density;
    this.panels = v.panels;
    this.motion = v.motion;
    this.apply();
  }
}

export const appearance = new AppearanceStore();
