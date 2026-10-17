/**
 * Pure helpers for the timeline's waveform + thumbnail strip.
 *
 * Kept free of Svelte runes and Tauri imports so `node --test` can exercise
 * them directly; the store and component are the only things that touch IPC.
 */

/** Cached frame file name for a zero-based index: `thumb_00001.jpg`. */
export function thumbFileName(index: number): string {
  return `thumb_${String(index + 1).padStart(5, "0")}.jpg`;
}

/**
 * How many cached frames to skip so the strip never renders thousands of
 * `<img>` nodes on a long video. The cache stays at 1 fps; only the DOM is
 * decimated, and each rendered frame is widened to keep the time axis honest.
 */
export function thumbStep(count: number, maxThumbs = 300): number {
  if (count <= maxThumbs) return 1;
  return Math.ceil(count / maxThumbs);
}

/** Zero-based frame index whose timestamp is closest to `timeSecs`. */
export function frameIndexAt(timeSecs: number, fps: number, count: number): number {
  if (fps <= 0 || count <= 0) return -1;
  const idx = Math.round(timeSecs * fps);
  return idx >= 0 && idx < count ? idx : -1;
}

/** Seconds into the source for zero-based frame `index`. */
export function frameTime(index: number, fps: number): number {
  return fps > 0 ? index / fps : 0;
}

/** `MM:SS` for a timestamp, for frame labels. */
export function formatClock(totalSecs: number): string {
  const s = Math.max(0, Math.floor(totalSecs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
