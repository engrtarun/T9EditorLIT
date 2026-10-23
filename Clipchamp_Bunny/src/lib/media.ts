import type { MediaInfo, ThumbnailStrip, WaveformData } from './types';
import { assetUrl } from './ipc';

/**
 * Real demo media, baked by `tools/generate-media.mjs` using the same FFmpeg
 * commands the Rust backend runs at runtime. In the Tauri build these fetches
 * are replaced by `invoke('probe_cached')`, `invoke('extract_waveform')` and
 * `invoke('extract_thumbnails')`.
 */

const BASE = '/assets';

export async function loadMediaInfo(): Promise<MediaInfo> {
  const r = await fetch(`${BASE}/media.json`);
  if (!r.ok) throw new Error(`media.json ${r.status}`);
  return (await r.json()) as MediaInfo;
}

export async function loadWaveform(): Promise<WaveformData> {
  const r = await fetch(`${BASE}/waveform.json`);
  if (!r.ok) throw new Error(`waveform.json ${r.status}`);
  return (await r.json()) as WaveformData;
}

export async function loadThumbnails(): Promise<ThumbnailStrip> {
  const r = await fetch(`${BASE}/thumbs/manifest.json`);
  if (!r.ok) throw new Error(`thumbs/manifest.json ${r.status}`);
  return (await r.json()) as ThumbnailStrip;
}

export function thumbUrl(strip: ThumbnailStrip, index: number): string {
  return assetUrl(`${strip.dir}/thumb_${String(index + 1).padStart(5, '0')}.jpg`);
}

/**
 * The library tile's poster.
 *
 * A `<video preload="metadata">` alone stays black: the browser has the
 * duration but has not decoded a frame yet. The `#t=` media fragment makes it
 * seek 100 ms in and paint that frame - no extra file, no extra decode, and it
 * works for a file whose filmstrip has never been generated.
 */
export function firstFrameUrl(url: string): string {
  if (!url || url.includes('#')) return url;
  return `${url}#t=0.1`;
}
