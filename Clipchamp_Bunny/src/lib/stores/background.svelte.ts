/**
 * The dashboard's background — the bundled clip, or the wallpaper the user
 * picked.
 *
 * One store, because two things must never disagree: what is painted behind
 * the dashboard, and what the profile menu says is painted. The menu can set
 * it, the layer can only read it, and `rev` is what tells the layer "the file
 * behind this path changed, re-mount".
 *
 * The zero-RAM rule lives in Rust (see `background_video.rs`): this store only
 * ever holds **paths**. The bytes are streamed by the webview through the
 * `asset://` protocol, which answers range requests by seeking in the file.
 *
 * Browser mode (`npm run dev`) has no Rust and no file picker, so it keeps
 * serving the same public asset the dashboard always used — the localhost
 * preview must stay a complete dashboard (AGENTS.md §8).
 */
import {
  assetUrl,
  backgroundCancel,
  backgroundImport,
  backgroundReset,
  backgroundState,
  isTauri,
  onBackgroundProgress,
  pickBackgroundFile
} from '../ipc';
import type { BackgroundState } from '../types';

/** What the dev server serves; also the fallback when Rust finds nothing. */
const PUBLIC_SRC = '/assets/leatTokyo.mp4';

/** Human-readable failure text out of whatever Rust threw. */
function reason(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

class BackgroundStore {
  /** `default` = the clip that ships with the app. */
  kind = $state<'default' | 'video' | 'image'>('default');
  /** Playable URL of the current background. */
  src = $state('');
  /** Still frame, painted before the video's first frame. */
  poster = $state('');
  /** File name the user picked, for the menu. */
  label = $state('');
  /** What the importer actually produced, for the menu's meta line. */
  width = $state(0);
  height = $state(0);
  seconds = $state(0);
  bytes = $state(0);
  /** Bumped whenever the file behind `src` changes. */
  rev = $state(0);

  ready = $state(false);
  /** True while Rust is probing/converting — the menu shows the bar. */
  busy = $state(false);
  pct = $state(0);
  stage = $state('');
  error = $state('');

  /** True once a custom file is live. */
  get custom(): boolean {
    return this.kind !== 'default';
  }

  /** Preview image for the menu swatch: the still, never a video file. */
  get preview(): string {
    return this.kind === 'image' ? this.src : this.poster;
  }

  /**
   * `1920×1080 · 3:00 · 43 MB` — what the importer really stored.
   *
   * Shown so nobody has to guess why a 4K file became 1080p: the app followed
   * the screen, and the number is right there in the menu.
   */
  get meta(): string {
    if (!this.custom || !this.width || !this.height) return '';
    const parts = [`${this.width}×${this.height}`];
    if (this.seconds > 0) {
      const total = Math.round(this.seconds);
      parts.push(`${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`);
    }
    if (this.bytes > 0) parts.push(`${Math.round(this.bytes / (1024 * 1024))} MB`);
    return parts.join(' · ');
  }

  apply(state: BackgroundState): void {
    this.kind = state.kind;
    this.src = state.path ? assetUrl(state.path) : '';
    this.poster = state.poster ? assetUrl(state.poster) : '';
    this.label = state.label ?? '';
    this.width = state.width ?? 0;
    this.height = state.height ?? 0;
    this.seconds = state.seconds ?? 0;
    this.bytes = state.bytes ?? 0;
    this.rev += 1;
    this.ready = true;
  }

  /** Ask what to paint. Cheap: one small JSON command, no file bytes. */
  async refresh(): Promise<void> {
    if (!isTauri()) {
      // Browser mode has no file picker and no app data folder: it keeps the
      // same public asset the dashboard always used, and says "default",
      // because that is exactly what it is.
      this.kind = 'default';
      this.src = PUBLIC_SRC;
      this.poster = '';
      this.label = '';
      this.width = 0;
      this.height = 0;
      this.seconds = 0;
      this.bytes = 0;
      this.ready = true;
      this.rev += 1;
      return;
    }
    this.apply(await backgroundState());
  }

  /** Open the native picker, then import whatever came back. */
  async choose(kind: 'video' | 'image'): Promise<void> {
    if (!isTauri()) {
      this.error = 'browser';
      return;
    }
    const path = await pickBackgroundFile(kind).catch(() => null);
    if (!path) return;
    await this.use(path);
  }

  /** Import one file. Progress arrives on `background:progress`. */
  async use(path: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.pct = 0;
    this.stage = 'convert';

    let off: (() => void) | undefined;
    try {
      off = await onBackgroundProgress((p) => {
        this.pct = p.pct;
        this.stage = p.stage;
      });
      this.apply(await backgroundImport(path));
    } catch (e) {
      const text = reason(e);
      // A cancel is a decision, not a failure — say nothing.
      if (!/cancel/i.test(text)) this.error = text;
    } finally {
      off?.();
      this.busy = false;
      this.pct = 0;
    }
  }

  /** Back to the clip that ships with the app. */
  async reset(): Promise<void> {
    if (this.busy) return;
    this.error = '';
    try {
      this.apply(await backgroundReset());
    } catch (e) {
      this.error = reason(e);
    }
  }

  /** Stop a conversion that is still running. */
  async cancel(): Promise<void> {
    await backgroundCancel();
  }
}

export const background = new BackgroundStore();
