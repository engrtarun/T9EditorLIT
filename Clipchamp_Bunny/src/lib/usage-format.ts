/**
 * Pure formatting and ring geometry for the API usage surfaces.
 *
 * Kept out of `usage-store.svelte.ts` on purpose: this file has no runes and
 * no I/O, so anything — the dashboard gauge, the editor chip, the dialog —
 * can import it without dragging the polling store along with it.
 *
 * The `-1` convention runs through all of it: a provider that publishes no
 * quota (Gemini sends no `x-ratelimit-*` headers at all) reports `-1`, and
 * `-1` renders as `—`. It never becomes `0%`, because "we measured zero" and
 * "the provider does not say" are different truths.
 */

/** 1,234 — or an em dash when nobody said. */
export const num = (n: number | undefined | null): string =>
  n === undefined || n === null ? '—' : new Intl.NumberFormat().format(n);

/** `-1` draws `—`; everything else rounds. Callers never pass a fake 0 for it. */
export const pct = (n: number): string => (n < 0 ? '—' : `${Math.round(n)}%`);

/** "31s" / "4m" / "2h" / "3d" — cheap, and enough for a "last call" line. */
export function timeAgo(iso?: string): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/* ------------------------------------------------------------- ring maths */

/** The rings share one `viewBox="0 0 200 200"`, so any box size scales both. */
export const R_OUTER = 84;
export const R_INNER = 66;
export const C_OUTER = 2 * Math.PI * R_OUTER;
export const C_INNER = 2 * Math.PI * R_INNER;

/**
 * How much of a ring to hide so the visible arc equals `value` percent.
 *
 * No rounding lives here: the daemon already rounds *up* when it computes
 * `used_percent` (1 of Groq's 1,000 requests a day is reported as 1, not
 * 0.1), because truncating would leave the ring blank for the first ten
 * calls of a day — which reads as "nothing has happened". This function
 * only draws what it is told, and `-1` draws nothing at all.
 */
export function ringOffset(circumference: number, value: number): number {
  if (value < 0) return circumference; // no published limit: draw nothing
  return circumference * (1 - Math.min(100, value) / 100);
}

/** Outer ring colour: red near the ceiling, gold before it, brand under it. */
export function ringColor(value: number): string {
  if (value < 0) return 'text-nc-mut';
  if (value >= 85) return 'text-nc-red';
  if (value >= 60) return 'text-nc-gold';
  return 'text-nc-brand';
}
