import type { MediaAsset } from '../types';

type Phase = 'loading' | 'ready' | 'failed';

interface Entry {
  asset: MediaAsset;
  phase: Phase;
  /** 0..1 import/probe progress. */
  progress: number;
  /** Set once the asset is on the timeline. */
  inUse: boolean;
  durationLabel: string;
}

/**
 * Media library. Only metadata + a streaming URL live here — never the file bytes.
 * The Rust side hands us a file:// / asset:// URL and the <video> streams it.
 */
class MediaStore {
  entries = $state<Entry[]>([]);

  add(file: File, url: string): Entry {
    const entry: Entry = {
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
      phase: 'loading',
      progress: 0,
      inUse: false,
      durationLabel: '0:00'
    };
    this.entries = [...this.entries, entry];
    this.simulate(entry.asset.id);
    return entry;
  }

  addMock(name: string, sizeBytes: number, durationSec = 274): Entry {
    const entry: Entry = {
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
      phase: 'ready',
      progress: 1,
      inUse: false,
      durationLabel: '4:34'
    };
    this.entries = [...this.entries, entry];
    return entry;
  }

  /** Mock import pipeline: probe → thumbnail → ready. */
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

  markInUse(id: string) {
    this.entries = this.entries.map((e) => (e.asset.id === id ? { ...e, inUse: true } : e));
  }

  remove(id: string) {
    this.entries = this.entries.filter((e) => e.asset.id !== id);
  }

  get(id: string) {
    return this.entries.find((e) => e.asset.id === id);
  }
}

export const media = new MediaStore();
export type { Entry as MediaEntry };
