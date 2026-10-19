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

/** Nice ruler step so labels never collide. */
export function niceStep(pxPerSec: number): number {
  for (const t of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) {
    if (t * pxPerSec >= 72) return t;
  }
  return 1200;
}
