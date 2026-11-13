/**
 * The import gate's report, mirroring `go/internal/mediaprobe.Report`.
 *
 * This is the answer to "what is this file, really?" before a single cut is
 * made. Every field here comes from one local ffprobe pass: no API call, no
 * full decode and no change to the original.
 */

export type GateSeverity = 'info' | 'warn' | 'action';

export interface GateIssue {
  code: string;
  severity: GateSeverity;
  title: string;
  detail: string;
  fix?: string;
  /** "remux" is the only machine repair the daemon offers today. */
  action?: 'remux' | string;
}

export interface MediaVideoStream {
  index: number;
  codec: string;
  width: number;
  height: number;
  pixel_format?: string;
  fps: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  start_secs: number;
  duration_secs: number;
  bit_rate_bps?: number;
  frames?: number;
}

export interface MediaAudioStream {
  index: number;
  codec: string;
  sample_rate: number;
  channels: number;
  bit_rate_bps?: number;
  start_secs: number;
  duration_secs: number;
}

export interface MediaBloat {
  actual_bitrate_bps: number;
  target_bitrate_bps: number;
  target_bytes: number;
  savings_bytes: number;
  savings_percent: number;
  bytes_per_minute: number;
  assumed_bits_per_pixel: number;
}

export interface MediaReport {
  path: string;
  container?: string;
  duration_secs: number;
  size_bytes: number;
  bit_rate_bps: number;
  video?: MediaVideoStream;
  audio?: MediaAudioStream;
  has_audio: boolean;
  audio_only?: boolean;
  portrait?: boolean;
  vfr?: boolean;
  av_offset_secs?: number;
  bloat?: MediaBloat;
  asr_copy_bytes?: number;
  issues?: GateIssue[];
}

/** The layout measurement for cases 37 and 38. */
export interface LayoutReport {
  cols: number;
  rows: number;
  motion: number[];
  detail: number[];
  samples: number;
  watermark_region?: string;
  facecam_region?: string;
  confidence: number;
  width: number;
  height: number;
}

export const GATE_CODES = {
  audioOnly: 'audio_only',
  noAudio: 'no_audio',
  vfr: 'vfr',
  color: 'color_metadata',
  avOffset: 'av_offset',
  bloat: 'bloat',
  durationSplit: 'duration_split',
  probeFailed: 'probe_failed',
  longSource: 'long_source',
  lowFps: 'low_fps'
} as const;

const SEVERITY_ORDER: Record<GateSeverity, number> = { action: 0, warn: 1, info: 2 };

/** Issues in the order the user should read them. */
export function sortedIssues(report: MediaReport | null): GateIssue[] {
  if (!report?.issues?.length) return [];
  return report.issues.toSorted(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)
  );
}

export function issueIcon(code: string): string {
  switch (code) {
    case GATE_CODES.bloat:
      return '◱';
    case GATE_CODES.vfr:
      return '⏱';
    case GATE_CODES.color:
      return '◐';
    case GATE_CODES.avOffset:
      return '⇄';
    case GATE_CODES.audioOnly:
      return '♫';
    case GATE_CODES.noAudio:
      return '⊘';
    case GATE_CODES.durationSplit:
      return '✂';
    case GATE_CODES.longSource:
      return '⏳';
    case GATE_CODES.probeFailed:
      return '⚠';
    default:
      return '·';
  }
}

export function severityClass(severity: GateSeverity): string {
  switch (severity) {
    case 'action':
      return 'border-nc-red/40 bg-nc-red/10 text-nc-red';
    case 'warn':
      return 'border-nc-gold/40 bg-nc-gold/10 text-nc-gold';
    default:
      return 'border-nc-line bg-nc-panel-2 text-nc-mut';
  }
}

/** "50 min · 5.3 GB · 1080p30" — the one line above the issue list. */
export function sourceSummary(report: MediaReport | null): string {
  if (!report) return '';
  const parts: string[] = [];
  if (report.duration_secs > 0) parts.push(durationLabel(report.duration_secs));
  if (report.size_bytes > 0) parts.push(formatBytes(report.size_bytes));
  if (report.video?.width && report.video.height) {
    const fps = report.video.fps > 0 ? `${Math.round(report.video.fps)}` : '';
    parts.push(`${report.video.width}×${report.video.height}${fps ? ` ${fps}fps` : ''}`);
  } else if (report.audio_only) {
    parts.push('audio only');
  }
  if (report.video?.codec) parts.push(report.video.codec);
  return parts.join(' · ');
}

/** The share of the source that actually reaches the API. */
export function asrPercent(report: MediaReport | null): number | null {
  if (!report?.asr_copy_bytes || !report.size_bytes) return null;
  return (report.asr_copy_bytes / report.size_bytes) * 100;
}

export function hasAction(report: MediaReport | null, action = 'remux'): boolean {
  return !!report?.issues?.some((i) => i.action === action);
}

export function isAudioProject(report: MediaReport | null): boolean {
  return !!report?.audio_only;
}

/** "watermark bottom-left · face-cam top-right" for the metadata chip. */
export function layoutLabel(layout: LayoutReport | null): string {
  if (!layout) return '';
  const parts: string[] = [];
  if (layout.watermark_region) parts.push(`watermark ${layout.watermark_region}`);
  if (layout.facecam_region) parts.push(`face-cam ${layout.facecam_region}`);
  return parts.join(' · ');
}

/**
 * The safe-crop note for a face-cam overlay.
 *
 * It is advice, not an action: the crop is the user's, and the only thing the
 * app knows is that a corner is much busier than the rest of the picture.
 */
export function overlayAdvice(layout: LayoutReport | null): string {
  if (!layout?.facecam_region) return '';
  return `Reels/shorts crop: keep the ${layout.facecam_region} corner inside the frame — that is where the presenter is.`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function durationLabel(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** A compact one-line verdict for the project card. */
export function gateVerdict(report: MediaReport | null): string {
  if (!report) return '';
  const worst = sortedIssues(report)[0];
  if (!worst) return 'Source is clean';
  return worst.title;
}
