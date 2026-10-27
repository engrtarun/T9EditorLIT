import type { MediaAsset } from '../types';

/**
 * The media library — **one project's media**, not a global pile.
 *
 * Holds **paths and metadata only** — never the file bytes. The video itself
 * is streamed by a `<video>` element from a `file://` / `asset://` URL, and
 * the engine reads it through short-lived FFmpeg children.
 *
 * Two rules keep it honest, and both were broken before:
 *
 *   1. **Scope.** A library belongs to the project that is open. Opening
 *      another project switches the library with it, so the previous project's
 *      media can never appear in "My media" of the new one. The list is a
 *      short JSON of paths, so it survives a restart without SQLite and
 *      without touching the heap (the video is still streamed on demand).
 *   2. **No self-insertion.** Adding a file to the library never puts it on
 *      the timeline. Only an explicit drag, or the tile's + button, does that
 *      — exactly like Clipchamp (see `docs/MEDIA_LIBRARY_TIMELINE.md`).
 */
export interface MediaEntry {
  asset: MediaAsset;
  /** Real filesystem path when the file came from disk (Tauri). */
  path: string | null;
  phase: 'loading' | 'ready' | 'failed';
  /** 0..1 import/probe progress. */
  progress: number;
  /** Set once the asset is the current project source. */
  inUse: boolean;
  durationLabel: string;
  /**
   * A poster the user chose by hand, as an absolute path on disk.
   *
   * `null` means "let the app pick a frame". The file lives in the app's own
   * cache folder, so the library still holds **paths, never bytes** - the
   * image is streamed by the webview through the asset protocol.
   */
  customThumb: string | null;
}

/** Where one project's library is remembered (paths + metadata, no bytes). */
const STORE_PREFIX = 't9.media.';

/**
 * A project that has no source file yet (created from the panel, still being
 * filled). Its library is real for the session and becomes the project's own
 * library the moment the user drops a clip on the timeline.
 */
const DRAFT_PREFIX = 'draft:';

/** The subset written to localStorage. `phase` is always `ready` on disk. */
interface StoredEntry {
  asset: MediaAsset;
  path: string | null;
  durationLabel: string;
  customThumb: string | null;
}

/**
 * A blob URL dies with the page, and a half-probed entry has nothing to show.
 * Neither is worth remembering.
 */
function storable(e: MediaEntry): boolean {
  if (e.phase !== 'ready') return false;
  if (e.path) return true;
  return !!e.asset.url && !e.asset.url.startsWith('blob:');
}

class MediaStore {
  entries = $state<MediaEntry[]>([]);

  /** Which project this library belongs to. `null` = no project open. */
  private scope = $state<string | null>(null);

  /** True while this library belongs to a project that has no source yet. */
  get isDraft(): boolean {
    return !!this.scope?.startsWith(DRAFT_PREFIX);
  }

  get hasScope(): boolean {
    return this.scope !== null;
  }

  /**
   * Show the library that belongs to `key`.
   *
   * The outgoing library is written to disk first, so switching projects never
   * loses an import; the incoming one is read back. `carryDraft` is the one
   * exception: a draft that just gained its source keeps the very entries the
   * user imported into it (that is the same project, now with a file).
   */
  enterScope(key: string | null, opts: { carryDraft?: boolean } = {}) {
    if (this.scope === key) return;
    const previous = this.scope;
    const carrying =
      !!opts.carryDraft && this.isDraft && key !== null && !key.startsWith(DRAFT_PREFIX);
    this.persist();
    // A draft is never reopened: its media either moves into the project that
    // just gained its source, or it is gone. Never leave the key behind.
    if (previous?.startsWith(DRAFT_PREFIX)) this.dropKey(previous);
    this.scope = key;
    if (carrying) this.persist();
    else this.entries = key ? this.restore(key) : [];
  }

  private dropKey(key: string) {
    try {
      localStorage.removeItem(STORE_PREFIX + key);
    } catch {
      /* private mode — nothing was stored anyway */
    }
  }

  /** A brand-new project: an empty library of its own. */
  startDraft(): string {
    const key = `${DRAFT_PREFIX}${crypto.randomUUID()}`;
    this.enterScope(key);
    return key;
  }

  private persist() {
    const key = this.scope;
    if (!key) return;
    try {
      const data: StoredEntry[] = this.entries.filter(storable).map((e) => ({
        asset: e.asset,
        path: e.path,
        durationLabel: e.durationLabel,
        customThumb: e.customThumb
      }));
      if (!data.length) localStorage.removeItem(STORE_PREFIX + key);
      else localStorage.setItem(STORE_PREFIX + key, JSON.stringify(data));
    } catch {
      /* private mode / quota — the library still works for this session */
    }
  }

  private restore(key: string): MediaEntry[] {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      if (!raw) return [];
      const data = JSON.parse(raw) as StoredEntry[];
      if (!Array.isArray(data)) return [];
      return data
        .filter(
          (e): e is StoredEntry =>
            !!e &&
            !!e.asset &&
            typeof e.asset.id === 'string' &&
            typeof e.asset.name === 'string' &&
            typeof e.asset.durationSecs === 'number'
        )
        .map((e) => ({
          asset: { ...e.asset },
          path: typeof e.path === 'string' ? e.path : null,
          phase: 'ready' as const,
          progress: 1,
          // Recomputed by the project store: only its own source is "in use".
          inUse: false,
          durationLabel: typeof e.durationLabel === 'string' ? e.durationLabel : '0:00',
          customThumb: typeof e.customThumb === 'string' ? e.customThumb : null
        }));
    } catch {
      /* corrupt entry — start clean rather than block the project */
      return [];
    }
  }

  /** Every mutation goes through here, so the disk copy can never trail. */
  private set(next: MediaEntry[]) {
    this.entries = next;
    this.persist();
  }

  /**
   * Register a file that is already on disk.
   *
   * `url` is the streamable counterpart of `path` (`asset://` under Tauri, the
   * public `/assets/...` path in the browser). Without it the tile has nothing
   * for its `<video>` to stream, so it fell back to the grey placeholder and
   * the library looked blank even though the media was there.
   */
  addPath(path: string, name: string, sizeBytes = 0, url = ''): MediaEntry {
    const entry: MediaEntry = {
      asset: {
        id: crypto.randomUUID(),
        name,
        url,
        durationSecs: 0,
        width: 0,
        height: 0,
        fps: 0,
        sizeBytes,
        videoCodec: 'unknown',
        audioCodec: null,
        sampleRate: null,
        channels: null
      },
      path,
      phase: 'loading',
      progress: 0,
      inUse: false,
      durationLabel: '…',
      customThumb: null
    };
    this.set([...this.entries, entry]);
    return entry;
  }

  /** Register a file the browser handed us (drag & drop). */
  add(file: File, url: string): MediaEntry {
    const entry: MediaEntry = {
      asset: {
        id: crypto.randomUUID(),
        name: file.name,
        url,
        durationSecs: 0,
        width: 0,
        height: 0,
        fps: 0,
        sizeBytes: file.size,
        videoCodec: 'unknown',
        audioCodec: null,
        sampleRate: null,
        channels: null
      },
      path: null,
      phase: 'loading',
      progress: 0,
      inUse: false,
      durationLabel: '…',
      customThumb: null
    };
    this.set([...this.entries, entry]);
    this.simulate(entry.asset.id);
    return entry;
  }

  addMock(name: string, sizeBytes: number, durationSec = 274): MediaEntry {
    const entry: MediaEntry = {
      asset: {
        id: crypto.randomUUID(),
        name,
        url: '',
        durationSecs: durationSec,
        width: 1920,
        height: 1080,
        fps: 60,
        sizeBytes,
        videoCodec: 'h264',
        audioCodec: 'aac',
        sampleRate: 48000,
        channels: 2
      },
      path: null,
      phase: 'ready',
      progress: 1,
      inUse: false,
      durationLabel: '4:34',
      customThumb: null
    };
    this.set([...this.entries, entry]);
    return entry;
  }

  /** Mock import pipeline: probe → thumbnail → ready (browser mode only). */
  private simulate(id: string) {
    let p = 0;
    const tick = () => {
      p = Math.min(1, p + 0.08 + Math.random() * 0.12);
      this.set(
        this.entries.map((e) =>
          e.asset.id === id ? { ...e, progress: p, phase: p >= 1 ? 'ready' : 'loading' } : e
        )
      );
      if (p < 1) setTimeout(tick, 120);
      else {
        this.set(
          this.entries.map((e) => {
            if (e.asset.id !== id) return e;
            // A picture already carries its own 5 s clip length; a video has
            // nothing yet in browser mode, so the mock fills in a real duration.
            const asset =
              e.asset.durationSecs > 0
                ? e.asset
                : { ...e.asset, durationSecs: 274, width: 1920, height: 1080, fps: 60 };
            const secs = Math.floor(asset.durationSecs);
            return {
              ...e,
              asset,
              durationLabel: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
            };
          })
        );
      }
    };
    setTimeout(tick, 200);
  }

  /**
   * Register a file that is already known - the project's own source.
   *
   * Unlike `add` and `addMock` there is no import pipeline to fake: the file
   * has been probed already, so the entry is ready the moment it appears.
   */
  adopt(asset: MediaAsset, path: string | null): MediaEntry {
    const secs = Math.max(0, Math.floor(asset.durationSecs));
    const entry: MediaEntry = {
      asset,
      path,
      phase: 'ready',
      progress: 1,
      inUse: true,
      durationLabel: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`,
      customThumb: null
    };
    this.set([...this.entries, entry]);
    return entry;
  }

  /** Update an entry after the real engine has probed it. */
  probed(id: string, patch: Partial<MediaEntry['asset']> & { durationLabel?: string }) {
    this.set(
      this.entries.map((e) => {
        if (e.asset.id !== id) return e;
        const { durationLabel, ...asset } = patch;
        return {
          ...e,
          phase: 'ready',
          progress: 1,
          durationLabel: durationLabel ?? e.durationLabel,
          asset: { ...e.asset, ...asset }
        };
      })
    );
  }

  markInUse(id: string) {
    this.set(this.entries.map((e) => (e.asset.id === id ? { ...e, inUse: true } : e)));
  }

  /**
   * Exactly one tile is "the current project" — in one write, not one per
   * entry. Called when a project's source is known.
   */
  focusSource(id: string) {
    this.set(this.entries.map((e) => ({ ...e, inUse: e.asset.id === id })));
  }

  markUnused(id: string) {
    this.set(this.entries.map((e) => (e.asset.id === id ? { ...e, inUse: false } : e)));
  }

  /** A probe that could not read the file: keep the tile, say so honestly. */
  failed(id: string) {
    this.set(
      this.entries.map((e) =>
        e.asset.id === id ? { ...e, phase: 'failed' as const, progress: 0 } : e
      )
    );
  }

  /** Rename the tile without mutating a `$state` entry in place. */
  renamed(id: string, name: string) {
    this.set(
      this.entries.map((e) => (e.asset.id === id ? { ...e, asset: { ...e.asset, name } } : e))
    );
  }

  remove(id: string) {
    this.set(this.entries.filter((e) => e.asset.id !== id));
  }

  /**
   * Attach (or clear) a hand-picked poster for one entry.
   *
   * The path is the file **in the app's cache folder**, not the picture the
   * user picked from their disk: the original may be moved or deleted, and a
   * library that points at random user files breaks the moment they do.
   */
  setCustomThumb(id: string, path: string | null) {
    this.set(this.entries.map((e) => (e.asset.id === id ? { ...e, customThumb: path } : e)));
  }

  get(id: string) {
    return this.entries.find((e) => e.asset.id === id);
  }

  get byPath() {
    return (path: string) => this.entries.find((e) => e.path === path);
  }
}

export const media = new MediaStore();
