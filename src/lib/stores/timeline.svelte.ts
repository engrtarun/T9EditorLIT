/**
 * Timeline visuals for the loaded source: waveform peaks and the ~1 fps
 * thumbnail strip, both produced by FFmpeg (Chunk 3).
 *
 * Only the small derived payloads live here — a few thousand floats and a
 * directory path. The JPEGs themselves are never read into JS; the strip is
 * rendered as asset-protocol `<img>` URLs that stream straight from disk.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { defaultCacheDir, errorMessage, extractThumbnails, extractWaveform } from "../ipc";
import { thumbFileName } from "../timeline-utils";
import type { ThumbnailStrip, WaveformData } from "../types";

/** Bucket count for the waveform. ~1.2 bars per pixel on a 1000 px timeline. */
const WAVEFORM_BARS = 1200;
/** Thumbnails are sampled once per second, as the spec requires. */
const THUMB_FPS = 1;
/** 160 px wide keeps each JPEG at ~5–8 KB while staying crisp when zoomed. */
const THUMB_WIDTH = 160;

/**
 * `convertFileSrc` wants the native separator (Stage.svelte passes backslashes
 * on Windows and it works), so join with the host's own.
 */
const PATH_SEP = navigator.userAgent.toLowerCase().includes("windows") ? "\\" : "/";

class TimelineStore {
  waveform = $state<WaveformData | null>(null);
  thumbs = $state<ThumbnailStrip | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  private sourcePath: string | null = null;

  get hasWaveform(): boolean {
    return this.waveform !== null;
  }

  get hasThumbs(): boolean {
    return this.thumbs !== null;
  }

  /** Peaks ready to draw, or null until extraction finishes. */
  get peaks(): number[] | null {
    return this.waveform?.peaks ?? null;
  }

  get thumbCount(): number {
    return this.thumbs?.count ?? 0;
  }

  get thumbFps(): number {
    return this.thumbs?.fps ?? THUMB_FPS;
  }

  /** Asset-protocol URL for zero-based frame `index`, or null when absent. */
  thumbUrl(index: number): string | null {
    const t = this.thumbs;
    if (!t || index < 0 || index >= t.count) return null;
    return convertFileSrc(`${t.dir}${PATH_SEP}${thumbFileName(index)}`);
  }

  /** Extract (or reuse the cached) waveform + strip for a source. */
  async load(sourcePath: string): Promise<void> {
    if (this.sourcePath === sourcePath && this.waveform && this.thumbs) return;

    this.sourcePath = sourcePath;
    this.waveform = null;
    this.thumbs = null;
    this.error = null;
    this.loading = true;

    try {
      // cacheDir resolves once and feeds both extractions in parallel.
      const cacheDirPromise = defaultCacheDir();
      // The two jobs are independent: a silent source has no waveform but
      // still deserves a thumbnail strip, so one failure must not hide both.
      const [waveRes, thumbsRes] = await Promise.allSettled([
        cacheDirPromise.then((dir) => extractWaveform(sourcePath, dir, WAVEFORM_BARS)),
        cacheDirPromise.then((dir) => extractThumbnails(sourcePath, dir, THUMB_FPS, THUMB_WIDTH)),
      ]);
      // A different source may have been picked while FFmpeg was running.
      if (this.sourcePath !== sourcePath) return;
      if (waveRes.status === "fulfilled") this.waveform = waveRes.value;
      if (thumbsRes.status === "fulfilled") this.thumbs = thumbsRes.value;

      const failed = [waveRes, thumbsRes].find((r) => r.status === "rejected");
      if (failed?.status === "rejected") this.error = errorMessage(failed.reason);
    } catch (err) {
      if (this.sourcePath === sourcePath) this.error = errorMessage(err);
    } finally {
      if (this.sourcePath === sourcePath) this.loading = false;
    }
  }

  clear(): void {
    this.waveform = null;
    this.thumbs = null;
    this.error = null;
    this.sourcePath = null;
  }
}

export const timeline = new TimelineStore();
