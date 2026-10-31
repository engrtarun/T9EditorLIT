/** `1:52` / `1:52.3` — the notebook asks for both a short and a precise form. */
export function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(2).padStart(5, '0')}`;
}

/**
 * How the playhead time is written. `auto` is the app's historical form
 * (`m:ss.cc`), with hours only when the project is long enough to need them.
 */
export type TimeFormat = 'auto' | 'mmss' | 'mmsscc' | 'hms' | 'hmscc' | 'seconds' | 'millis';

/**
 * The settings picker's order and labels.
 *
 * `typed` says whether the printed form can be typed back into the timecode
 * box (`parseTimecode`); a suffix like `83.46s` reads well but would not parse,
 * so the editor falls back to `m:ss.cc` when it opens the box.
 */
export const TIME_FORMATS: Array<{ id: TimeFormat; label: string; typed: boolean }> = [
  { id: 'auto', label: 'Auto', typed: true },
  { id: 'mmss', label: 'm:ss', typed: true },
  { id: 'mmsscc', label: 'm:ss.cc', typed: true },
  { id: 'hms', label: 'h:mm:ss', typed: true },
  { id: 'hmscc', label: 'h:mm:ss.cc', typed: true },
  { id: 'seconds', label: 'sec', typed: false },
  { id: 'millis', label: 'ms', typed: false }
];

const TIME_FORMAT_IDS = new Set<TimeFormat>(TIME_FORMATS.map((f) => f.id));

/** Narrow anything localStorage hands back to a known format. */
export function isTimeFormat(raw: unknown): raw is TimeFormat {
  return typeof raw === 'string' && TIME_FORMAT_IDS.has(raw as TimeFormat);
}

/**
 * Write a time in the format the user picked.
 *
 * Centiseconds are derived from a single rounded centisecond count, so
 * `59.999` carries to `1:00.00` instead of printing `0:59.100`.
 */
export function formatTimecode(sec: number, fmt: TimeFormat = 'auto'): string {
  const s = Math.max(0, sec);
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const whole = Math.floor((cs % 6_000) / 100);
  const centis = cs % 100;
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (fmt) {
    case 'seconds':
      return `${s.toFixed(2)}s`;
    case 'millis':
      return `${Math.round(s * 1000)} ms`;
    case 'mmss':
      return `${m}:${pad(whole)}`;
    case 'hms':
      return `${h}:${pad(m)}:${pad(whole)}`;
    case 'hmscc':
      return `${h}:${pad(m)}:${pad(whole)}.${pad(centis)}`;
    case 'mmsscc':
      return `${m}:${pad(whole)}.${pad(centis)}`;
    case 'auto':
    default:
      return h > 0
        ? `${h}:${pad(m)}:${pad(whole)}.${pad(centis)}`
        : `${m}:${pad(whole)}.${pad(centis)}`;
  }
}

export function fmtShort(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Human duration for the Overtime counter: `1h 52m` / `34m` / `8m 12s`. */
export function fmtHuman(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function fmtSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb > 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Parse a timecode a person typed into seconds.
 *
 * Clipchamp's timecode box is click-to-type: you type the time you want and
 * press Enter. People do not type one canonical form, so this accepts the
 * handful that are actually used:
 *
 *     "83"         83 s
 *     "1:23"       1 min 23 s
 *     "1:23.45"    1 min 23.45 s
 *     "0:05.63"    the form the app itself prints
 *     "1:02:03"    1 h 2 min 3 s
 *     "1:02:03.5"  …and half a second
 *     "1,5"        1.5 s (comma decimal — how half of Europe types it)
 *
 * Anything that is not a timecode returns `null`, so the caller can leave the
 * playhead where it is instead of seeking to a guess. `HH:MM:SS:FF` frame
 * timecodes are deliberately rejected: converting frames needs the source fps,
 * and guessing it would land on the wrong frame.
 */
export function parseTimecode(text: string): number | null {
  const raw = text.trim().replace(',', '.');
  // digits, up to three colon-separated groups, one optional decimal tail
  if (!/^\d{1,3}(:\d{1,2}){0,2}(\.\d{1,3})?$/.test(raw)) return null;
  const parts = raw.split(':').map(Number);
  // Right to left: the last group is seconds, then minutes, then hours.
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Nice ruler step so labels never collide. */
export function niceStep(pxPerSec: number): number {
  for (const t of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) {
    if (t * pxPerSec >= 72) return t;
  }
  return 1200;
}
