import type { SilenceRange, TranscriptLine } from './types';

/**
 * The same silence map, two different questions.
 *
 * `silencedetect` returns every pause: a 0.4 s edit seam, a 2 s breath and an
 * 87 s dead zone are all "silence" to it. A flat cut list built from that is
 * unusable - the playbook's live file had 274 gaps and only 46 of them were
 * worth a button (case 35). This module classifies the map once, and every
 * consumer (the cut suggestion, the timeline preview and the summary chip)
 * reads the same tiers.
 */

export type GapTier = 'micro' | 'medium' | 'big';

export interface Gap {
  start: number;
  end: number;
  duration: number;
  tier: GapTier;
}

export interface GapStats {
  micro: number;
  medium: number;
  big: number;
  microSecs: number;
  mediumSecs: number;
  bigSecs: number;
  /** What the default "cut big gaps" pass would remove. */
  cuttableSecs: number;
  longestSecs: number;
  total: number;
}

export interface ClassifyOptions {
  /** Below this, a gap is an edit seam, not a cut (case 35). */
  microMax?: number;
  /** At or above this, a gap is a cut candidate. */
  bigMin?: number;
  /**
   * Two silence spans separated by less than this are one event.
   *
   * This is the reverb-tail rule (case 21): an auditorium tail leaves a thin
   * strip of energy between two detected silences. Merging is only allowed
   * when no transcript line covers the strip, because a short real word in
   * that strip must not be swallowed by a merge.
   */
  mergeBelow?: number;
  /** Lines used to veto a merge that would hide speech. */
  lines?: Pick<TranscriptLine, 'startSec' | 'endSec'>[];
}

const DEFAULTS = { microMax: 1.5, bigMin: 5, mergeBelow: 1 } as const;

/**
 * Classify a raw silence map into micro / medium / big gaps.
 *
 * Invalid (negative or inverted) spans are dropped rather than repaired: a
 * broken range from a decoder must never become a cut.
 */
export function classifyGaps(ranges: SilenceRange[], opts: ClassifyOptions = {}): Gap[] {
  const microMax = opts.microMax ?? DEFAULTS.microMax;
  const bigMin = opts.bigMin ?? DEFAULTS.bigMin;
  const mergeBelow = opts.mergeBelow ?? DEFAULTS.mergeBelow;
  const lines = opts.lines ?? [];

  const clean = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => ({ start: r.start, end: r.end }))
    .toSorted((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const r of clean) {
    const prev = merged.at(-1);
    if (!prev) {
      merged.push({ ...r });
      continue;
    }
    const gap = r.start - prev.end;
    const touching = gap <= 0;
    const bridgeable =
      !touching &&
      gap < mergeBelow &&
      !lines.some((l) => l.endSec > prev.end && l.startSec < r.start);
    if (touching || bridgeable) {
      prev.end = Math.max(prev.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  return merged.map((r) => {
    const duration = r.end - r.start;
    const tier: GapTier = duration >= bigMin ? 'big' : duration < microMax ? 'micro' : 'medium';
    return { ...r, duration, tier };
  });
}

/** Counts and honest seconds for the summary chip. */
export function gapStats(gaps: Gap[]): GapStats {
  const stats: GapStats = {
    micro: 0,
    medium: 0,
    big: 0,
    microSecs: 0,
    mediumSecs: 0,
    bigSecs: 0,
    cuttableSecs: 0,
    longestSecs: 0,
    total: gaps.length
  };
  for (const g of gaps) {
    if (g.tier === 'micro') {
      stats.micro++;
      stats.microSecs += g.duration;
    } else if (g.tier === 'medium') {
      stats.medium++;
      stats.mediumSecs += g.duration;
    } else {
      stats.big++;
      stats.bigSecs += g.duration;
    }
    stats.longestSecs = Math.max(stats.longestSecs, g.duration);
  }
  stats.cuttableSecs = stats.bigSecs;
  return stats;
}

/**
 * The spans a silence pass should actually propose.
 *
 * Default is big gaps only. Medium gaps are opt-in: they are often a breath
 * or a deliberate beat, and cutting all of them makes the video feel chopped.
 * Micro gaps are never offered - they are edit seams, not dead air.
 */
export function cutCandidates(gaps: Gap[], opts: { includeMedium?: boolean } = {}): SilenceRange[] {
  return gaps
    .filter((g) => g.tier === 'big' || (opts.includeMedium && g.tier === 'medium'))
    .map((g) => ({ start: g.start, end: g.end }));
}

/**
 * Keep-zones that a silence pass must never cut through.
 *
 * Case 40: the intro and outro are the creator's hook and call to action, and
 * the playbook measured both being eaten by a flat auto-cut. The shape pass
 * supplies these ranges; automatic cuts subtract them instead of trusting a
 * gap that happens to contain a CTA line.
 */
export function subtractKeepZones(ranges: SilenceRange[], keep: SilenceRange[]): SilenceRange[] {
  if (!keep.length) return ranges;
  let out = ranges.map((r) => ({ ...r }));
  for (const k of keep) {
    if (k.end <= k.start) continue;
    const next: SilenceRange[] = [];
    for (const r of out) {
      if (r.end <= k.start || r.start >= k.end) {
        next.push(r);
        continue;
      }
      if (r.start < k.start) next.push({ start: r.start, end: k.start });
      if (r.end > k.end) next.push({ start: k.end, end: r.end });
    }
    out = next;
  }
  return out.filter((r) => r.end - r.start >= 0.2);
}

/** "46 bade gaps = 23:28 · 113 medium · 115 micro" */
export function gapSummary(stats: GapStats | null): string {
  if (!stats || !stats.total) return '';
  const parts = [`${stats.big} bade gaps = ${clock(stats.bigSecs)}`];
  if (stats.medium) parts.push(`${stats.medium} medium`);
  if (stats.micro) parts.push(`${stats.micro} micro`);
  return parts.join(' · ');
}

export function clock(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
