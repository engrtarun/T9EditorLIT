/** `1:52` / `1:52.3` — the notebook asks for both a short and a precise form. */
export function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(2).padStart(5, '0')}`;
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
