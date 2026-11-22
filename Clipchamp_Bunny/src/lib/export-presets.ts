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
export type ExportFormat = 'video' | 'gif' | 'mp3' | 'wav';

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
    label: 'Audio only · MP3',
    ext: 'mp3',
    note: 'small, universal — music, voiceover, dialogue'
  },
  {
    id: 'wav',
    label: 'Audio only · WAV',
    ext: 'wav',
    note: 'lossless PCM — for editing and archiving'
  }
];

/**
 * Video containers offered when the engine supports them (caps.container).
 * MP4 stays the default; MKV/MOV/WEBM are one dropdown away.
 */
export interface ContainerPreset {
  id: string;
  label: string;
  ext: string;
  note: string;
}

export const CONTAINERS: ContainerPreset[] = [
  { id: 'mp4', label: 'MP4', ext: 'mp4', note: 'best compatibility' },
  { id: 'mkv', label: 'MKV', ext: 'mkv', note: 'most flexible' },
  { id: 'mov', label: 'MOV', ext: 'mov', note: 'Apple / Final Cut' },
  { id: 'webm', label: 'WebM', ext: 'webm', note: 'web delivery' }
];

/**
 * What the app picks for you the moment Export opens. "Best" means quality
 * first without wrecking compatibility — every field is still editable.
 */
export const RECOMMENDED_EXPORT = {
  format: 'video' as ExportFormat,
  container: 'mp4',
  codec: 'h264',
  crf: 18,
  fps: null,
  includeAudio: true,
  bitrate: 320,
  sampleRate: 48000,
  channels: 2,
  twoPass: false
};

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
    case 'wav':
      return `${base} (audio).wav`;
    default:
      return `${base} (cut).mp4`;
  }
}

/** How big an MP3 of this length will be, in bytes. */
export function estimateMp3Bytes(durationSecs: number, bitrateKbps: number): number {
  if (durationSecs <= 0 || bitrateKbps <= 0) return 0;
  return Math.round((durationSecs * bitrateKbps * 1000) / 8);
}

/** 16-bit PCM: duration × rate × channels × 2 bytes. */
export function estimateWavBytes(
  durationSecs: number,
  sampleRate: number,
  channels: number
): number {
  if (durationSecs <= 0 || sampleRate <= 0 || channels <= 0) return 0;
  return Math.round(durationSecs * sampleRate * channels * 2);
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

/* ------------------------------------------------------------------ caps */

/**
 * What the installed backend actually understands.
 *
 * The export UI is built ahead of the engine: every control exists on screen,
 * and this flag decides whether picking a value changes the render or only
 * announces that the engine update is still coming (EXPORT.md B1-*). The app
 * probes `export_capabilities` on start; the fallback below is "nothing yet",
 * so an older binary can never be lied to.
 */
export interface ExportCaps {
  /** `fps` option in ExportOptions (EXPORT.md B1-2). */
  fps: boolean;
  /** `codec` option — h264 / h265 / av1 choice (B1-2). */
  codec: boolean;
  /** `container` option — mov / mkv / webm besides mp4 (B1-2). */
  container: boolean;
  /** `includeAudio` option — drop the sound track (B1-2). */
  includeAudio: boolean;
  /** `crf` / `videoBitrateKbps` / `twoPass` quality knobs (B1-4). */
  quality: boolean;
  /** `preflight_export` — disk space + overwrite check (B1-3). */
  preflight: boolean;
  /** `list_export_history` (B1-1). */
  history: boolean;
  /** `read_export_log` (B1-5). */
  logs: boolean;
}

/** Every capability off — what an engine without EXPORT.md's additions answers. */
export const FALLBACK_CAPS: ExportCaps = {
  fps: false,
  codec: false,
  container: false,
  includeAudio: false,
  quality: false,
  preflight: false,
  history: false,
  logs: false
};

/** Probe answer (possibly partial) over the fallback, so unknown keys stay false. */
export function mergeCaps(partial: Partial<ExportCaps> | null | undefined): ExportCaps {
  return { ...FALLBACK_CAPS, ...(partial ?? {}) };
}

/* ---------------------------------------------------------- quick presets */

/** The four cards on the Quick Export tab. */
export type QuickPresetId = 'youtube' | 'shorts' | '4k' | 'custom';

export interface QuickPreset {
  id: QuickPresetId;
  label: string;
  /** The line under the label — the number the card promises. */
  note: string;
  /** Resolution the card sets; `null` = leave the panel's own choice alone. */
  resolution: ResolutionId | null;
  /**
   * Canvas the card forces, or `null` for "the project's own shape".
   * Only Shorts carries one — a vertical export of a horizontal project is
   * exactly what that card is for, and it must not reshape the project.
   */
  canvas: [number, number] | null;
}

export const QUICK_PRESETS: QuickPreset[] = [
  { id: 'youtube', label: 'YouTube', note: '1080p', resolution: '1080p', canvas: null },
  { id: 'shorts', label: 'Shorts', note: '1080 × 1920', resolution: '1080p', canvas: [1080, 1920] },
  { id: '4k', label: '4K UHD', note: '3840 × 2160', resolution: '4k', canvas: null },
  { id: 'custom', label: 'Custom', note: 'Your Choice', resolution: null, canvas: null }
];

/**
 * Which card the current settings light up.
 *
 * Derived, never stored: the cards are shortcuts over the same state the
 * rows edit, so changing a row by hand simply moves the tick to "Custom".
 */
export function activeQuickPreset(
  resolution: ResolutionId,
  canvasOverride: [number, number] | null
): QuickPresetId {
  // A vertical canvas can only come from the Shorts card — the project's own
  // frame is applied elsewhere and is not this panel's choice.
  if (canvasOverride && canvasOverride[1] > canvasOverride[0]) return 'shorts';
  if (resolution === '4k') return '4k';
  if (resolution === '1080p') return 'youtube';
  return 'custom';
}

/* ------------------------------------------------------------ frame rate */

/** The frame rates the panel offers, in fps. */
export const FRAME_RATES = [24, 25, 30, 50, 60] as const;

/**
 * The Frame Rate row's value.
 *
 * `null` means "keep the source's own rate" — the honest default, and the
 * only one an engine without the `fps` option can honour.
 */
export function frameRateLabel(fps: number | null, sourceFps: number): string {
  if (fps && fps > 0) return `${fps} FPS`;
  const src = Math.round(sourceFps);
  return src > 0 ? `${src} FPS (source)` : 'Source';
}

/** Does this choice ask the engine for something it cannot do yet? */
export function needsBackend(fps: number | null, sourceFps: number, caps: ExportCaps): boolean {
  if (!caps.fps && fps && fps > 0 && Math.round(sourceFps) !== fps) return true;
  return false;
}

/* ---------------------------------------------------------------- labels */

/** The Format row's value: the container the file will carry. */
export function formatValueLabel(format: ExportFormat): string {
  switch (format) {
    case 'gif':
      return 'GIF';
    case 'mp3':
      return 'MP3';
    case 'wav':
      return 'WAV';
    default:
      return 'MP4';
  }
}

/**
 * The Resolution row's value: `1080p (1920 × 1080)`.
 *
 * The frame in parentheses is what the file will really be — the rescale
 * target when there is one, the source size when there is not.
 */
export function resolutionValueLabel(
  resolution: ResolutionId,
  mediaWidth: number,
  mediaHeight: number
): string {
  const preset = resolutionPreset(resolution);
  const frame = targetFrame(resolution, mediaWidth, mediaHeight);
  const dims =
    frame ?? (mediaWidth && mediaHeight ? { width: mediaWidth, height: mediaHeight } : null);
  return dims ? `${preset.label} (${dims.width} × ${dims.height})` : preset.label;
}

/* -------------------------------------------------------------- progress */

/** Human names for the engine's progress stages. */
export function stageLabel(stage: string): string {
  switch (stage) {
    case 'scan':
      return 'Preparing';
    case 'cut':
      return 'Rendering';
    case 'concat':
      return 'Joining';
    case 'audio':
      return 'Audio';
    case 'mux':
      return 'Finalizing';
    case 'gif':
      return 'Frames';
    case 'done':
      return 'Done';
    default:
      return stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : 'Working';
  }
}

/**
 * Seconds left, from what has happened so far — or `null` while there is
 * nothing to extrapolate from (0% or no clock yet).
 *
 * Linear on purpose: a bar that has done a third of the work in a known time
 * owes the user a number, not a model of FFmpeg's mood.
 */
export function etaSeconds(percent: number, elapsedSecs: number): number | null {
  if (!(percent > 0) || !(elapsedSecs > 0) || percent >= 100) return null;
  return Math.round((elapsedSecs / percent) * (100 - percent));
}

/** `1:05` / `12:04` for the elapsed and ETA clocks. */
export function fmtClock(totalSecs: number): string {
  if (!Number.isFinite(totalSecs) || totalSecs < 0) return '—';
  const s = Math.round(totalSecs);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
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
