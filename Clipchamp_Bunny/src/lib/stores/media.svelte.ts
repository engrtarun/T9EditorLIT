import type { MediaAsset } from '../types';

/**
 * The media library.
 *
 * Holds **paths and metadata only** — never the file bytes. The video itself
 * is streamed by a `<video>` element from a `file://` / `asset://` URL, and
 * the engine reads it through short-lived FFmpeg children.
 *
 * A file that arrives while a project is open becomes a **new project**: the
 * library keeps the old one so it can be reopened, but the new file is what
 * gets edited.
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
}

class MediaStore {
  entries = $state<MediaEntry[]>([]);

  /** Register a file that is already on disk. */
  addPath(path: string, name: string, sizeBytes = 0): MediaEntry {
    const entry: MediaEntry = {
      asset: {
        id: crypto.randomUUID(),
        name,
        url: '',
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
      durationLabel: '…'
    };
    this.entries = [...this.entries, entry];
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
      durationLabel: '…'
    };
    this.entries = [...this.entries, entry];
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
      durationLabel: '4:34'
    };
    this.entries = [...this.entries, entry];
    return entry;
  }

  /** Mock import pipeline: probe → thumbnail → ready (browser mode only). */
  private simulate(id: string) {
    let p = 0;
    const tick = () => {
      p = Math.min(1, p + 0.08 + Math.random() * 0.12);
      this.entries = this.entries.map((e) =>
        e.asset.id === id ? { ...e, progress: p, phase: p >= 1 ? 'ready' : 'loading' } : e
      );
      if (p < 1) setTimeout(tick, 120);
      else {
        this.entries = this.entries.map((e) =>
          e.asset.id === id
            ? { ...e, asset: { ...e.asset, durationSecs: 274, width: 1920, height: 1080, fps: 60 } }
            : e
        );
      }
    };
    setTimeout(tick, 200);
  }

  /** Update an entry after the real engine has probed it. */
  probed(id: string, patch: Partial<MediaEntry['asset']> & { durationLabel?: string }) {
    this.entries = this.entries.map((e) => {
      if (e.asset.id !== id) return e;
      const { durationLabel, ...asset } = patch;
      return {
        ...e,
        phase: 'ready',
        progress: 1,
        durationLabel: durationLabel ?? e.durationLabel,
        asset: { ...e.asset, ...asset }
      };
    });
  }

  markInUse(id: string) {
    this.entries = this.entries.map((e) => (e.asset.id === id ? { ...e, inUse: true } : e));
  }

  markUnused(id: string) {
    this.entries = this.entries.map((e) => (e.asset.id === id ? { ...e, inUse: false } : e));
  }

  remove(id: string) {
    this.entries = this.entries.filter((e) => e.asset.id !== id);
  }

  get(id: string) {
    return this.entries.find((e) => e.asset.id === id);
  }

  get byPath() {
    return (path: string) => this.entries.find((e) => e.path === path);
  }
}

export const media = new MediaStore();
