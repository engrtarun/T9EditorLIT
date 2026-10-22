/**
 * The export menu — every preset the export panel offers, in one pure place.
 *
 * Clipchamp's export dropdown is a list of *resolutions* plus GIF; this app
 * adds the audio-only MP3 next to them, because "give me the MP3 of this
 * video" is the single most asked-for thing a cutter can do.
 *
 * Everything in this file is data or pure arithmetic, so the panel stays
 * declarative and the numbers can be unit-tested (node --test).
 */

/** What kind of file comes out. */
export type ExportFormat = 'video' | 'gif' | 'mp3';

export interface FormatPreset {
  id: ExportFormat;
  label: string;
  /** The extension the output file must have — FFmpeg picks the muxer by it. */
  ext: string;
  /** The one line under the label. */
  note: string;
}

export const FORMATS: FormatPreset[] = [
  { id: 'video', label: 'Video', ext: 'mp4', note: 'the cut, as an MP4' },
  { id: 'gif', label: 'GIF', ext: 'gif', note: 'a short looping clip' },
  {
    id: 'mp3',
    label: 'Audio only',
    ext: 'mp3',
    note: 'music, voiceover, dialogue — no picture at all'
  }
];

/** The video resolutions, in the order Clipchamp lists them. */
export type ResolutionId = 'source' | '480p' | '720p' | '1080p' | '4k';

export interface ResolutionPreset {
  id: ResolutionId;
  label: string;
  note: string;
  /** The short side of the frame, in pixels. `null` = no rescale at all. */
  shortSide: number | null;
}

export const RESOLUTIONS: ResolutionPreset[] = [
  { id: 'source', label: 'Source', note: 'as recorded — no rescale', shortSide: null },
  { id: '480p', label: '480p', note: 'for drafts', shortSide: 480 },
  { id: '720p', label: '720p', note: 'smaller file, faster export', shortSide: 720 },
  { id: '1080p', label: '1080p', note: 'high quality', shortSide: 1080 },
  {
    id: '4k',
    label: '4K UHD',
    note: 'preview — make the most of your 4K footage',
    shortSide: 2160
  }
];

/** The MP3 bitrates on offer, in kbps. */
export const BITRATES = [128, 192, 256, 320] as const;

/** The MP3 sample rates on offer, in Hz. */
export const SAMPLE_RATES = [44100, 48000] as const;

/** The longest clip a GIF export accepts, in seconds. */
export const GIF_MAX_SECS = 15;

/** The frames per second in an exported GIF. */
export const GIF_FPS = 10;

/** The width of an exported GIF, in pixels. */
export const GIF_WIDTH = 480;

/** The preset for one format. */
export function formatPreset(format: ExportFormat): FormatPreset {
  return FORMATS.find((f) => f.id === format) ?? FORMATS[0];
}

/** The preset for one resolution. */
export function resolutionPreset(resolution: ResolutionId): ResolutionPreset {
  return RESOLUTIONS.find((r) => r.id === resolution) ?? RESOLUTIONS[0];
}

/**
 * The frame the export lands on.
 *
 * `null` when nothing is rescaled — either because the source size was asked
 * for, or because the source is *smaller* than the target (upscaling a 480p
 * recording to 4K costs a lot of time and buys nothing).
 */
export function targetFrame(
  resolution: ResolutionId,
  width: number,
  height: number
): { width: number; height: number } | null {
  const preset = resolutionPreset(resolution);
  if (preset.shortSide === null) return null;
  if (!width || !height) return null;

  const target = preset.shortSide;
  const short = Math.min(width, height);
  if (target >= short) return null;

  const even = (v: number) => {
    const r = Math.max(2, Math.round(v));
    return r % 2 === 0 ? r : r + 1;
  };
  // "720p" means the *short* side is 720 — a phone recording kept upright has
  // to come out 720 wide, not 720 tall.
  return width >= height
    ? { width: even((width * target) / height), height: target }
    : { width: target, height: even((height * target) / width) };
}

/** The default output file name for a project and a format. */
export function defaultFileName(projectName: string, format: ExportFormat): string {
  const base = (projectName || 't9-editor-lit').replace(/[^\w\- ]+/g, '');
  switch (format) {
    case 'gif':
      return `${base}.gif`;
    case 'mp3':
      return `${base} (audio).mp3`;
    default:
      return `${base} (cut).mp4`;
  }
}

/** How big an MP3 of this length will be, in bytes. */
export function estimateMp3Bytes(durationSecs: number, bitrateKbps: number): number {
  if (durationSecs <= 0 || bitrateKbps <= 0) return 0;
  return Math.round((durationSecs * bitrateKbps * 1000) / 8);
}

/**
 * How big a GIF of this length will be, in bytes.
 *
 * A rough average of about 0.02 bytes per pixel per frame — good to within
 * a factor of two on real footage, which is all an estimate has to be.
 */
export function estimateGifBytes(
  durationSecs: number,
  fps: number = GIF_FPS,
  width: number = GIF_WIDTH,
  height: number = 270
): number {
  if (durationSecs <= 0) return 0;
  const frames = Math.max(1, Math.round(durationSecs * fps));
  return Math.round(frames * width * height * 0.02);
}

/**
 * The FFmpeg filter graph that joins the kept ranges into one stream.
 *
 * The desktop renders this in Rust; the browser preview's dev server renders
 * the same graph in Node. It lives here so both halves cannot drift apart.
 */
export function audioFilter(segments: Array<{ start: number; end: number }>): string | null {
  if (!segments.length) return null;
  const t = (v: number) => v.toFixed(6);
  if (segments.length === 1) {
    const s = segments[0];
    return `[0:a]atrim=start=${t(s.start)}:end=${t(s.end)},asetpts=PTS-STARTPTS[aout]`;
  }
  const parts = segments.map(
    (s, i) => `[0:a]atrim=start=${t(s.start)}:end=${t(s.end)},asetpts=PTS-STARTPTS[a${i}]`
  );
  const labels = segments.map((_, i) => `[a${i}]`).join('');
  parts.push(`${labels}concat=n=${segments.length}:v=0:a=1[aout]`);
  return parts.join(';');
}
