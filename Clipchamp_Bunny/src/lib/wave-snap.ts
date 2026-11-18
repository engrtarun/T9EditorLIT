import type { WaveformData } from './types';
import type { WordCutPlan } from './word-cut';

/**
 * Snap a cut boundary onto the quiet gap in the audio.
 *
 * Why this exists: a transcript line only has word timings when the engine
 * produced them. A pasted SRT, an imported VTT or a vendor that returns
 * line-level times gives none — and spreading the selection over the line by
 * character count lands the cut in the middle of a word. The waveform is the
 * only evidence of where the words really start and stop, so the boundary is
 * moved to the quietest point nearby: the pause between two words. That is
 * the same point a person would pick by scrubbing, without the scrubbing.
 *
 * The peaks are buckets, not samples (4096 bars over a three-minute file is
 * ~50 ms per bar). The minimum bucket is refined with a parabola through its
 * two neighbours, which recovers where the dip bottoms out *inside* the
 * bucket — the difference between "about 1.5 s" and "1,486 ms".
 */

/** A boundary moved onto a real pause, ready to show and to cut. */
export interface WaveSnap {
  /** The time to cut at, in seconds. */
  sec: number;
  /** True when the audio actually moved the boundary. */
  snapped: boolean;
  /** Peak level at the chosen point (0..1), for the tooltip. */
  quiet: number;
}

export interface WaveSnapOptions {
  /** How far to look, in seconds. Wider when the time is a character-count guess. */
  windowSec?: number;
  /** A dip must be at most this fraction of the loudest bucket in the window. */
  ratio?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Find the quietest point within `windowSec` of `sec`.
 *
 * Returns `sec` unchanged when there is no dip: words that run together have
 * no pause to snap to, and inventing one would cut a phoneme in half. The
 * snap never travels further than the window, so a bad peak map cannot turn
 * one word into a paragraph.
 */
export function snapToGap(
  wave: WaveformData | null | undefined,
  sec: number,
  opts: WaveSnapOptions = {}
): WaveSnap {
  const unchanged: WaveSnap = { sec, snapped: false, quiet: 1 };
  const peaks = wave?.peaks;
  const duration = wave?.durationSecs ?? 0;
  if (!peaks?.length || !(duration > 0)) return unchanged;

  const bucket = duration / peaks.length;
  const span = Math.max(2, Math.ceil((opts.windowSec ?? 0.09) / bucket));
  const ratio = opts.ratio ?? 0.32;
  const centre = sec / bucket;
  const lo = Math.max(0, Math.floor(centre) - span);
  const hi = Math.min(peaks.length - 1, Math.floor(centre) + span);

  let best = -1;
  let loudest = 0;
  for (let i = lo; i <= hi; i++) {
    const peak = peaks[i];
    if (peak > loudest) loudest = peak;
    if (
      best < 0 ||
      peak < peaks[best] ||
      // Equal dips: prefer the one nearest the time the transcript asked for.
      (peak === peaks[best] && Math.abs(i - centre) < Math.abs(best - centre))
    ) {
      best = i;
    }
  }
  if (best < 0) return unchanged;

  const quiet = peaks[best];
  // No dip anywhere near: the words are continuous. Leave the time alone.
  if (quiet > 0.02 && quiet > loudest * ratio) return unchanged;

  // Parabola through (best-1, best, best+1). The vertex is where the gap
  // bottoms out; a flat or inverted trio keeps the bucket centre.
  const a = peaks[Math.max(0, best - 1)];
  const b = quiet;
  const c = peaks[Math.min(peaks.length - 1, best + 1)];
  const denom = a - 2 * b + c;
  const offset = denom > 1e-6 ? clamp((0.5 * (a - c)) / denom, -0.5, 0.5) : 0;

  const snapped = clamp((best + 0.5 + offset) * bucket, 0, duration);
  if (Math.abs(snapped - sec) < 0.001) return unchanged;
  return { sec: snapped, snapped: true, quiet };
}

/**
 * Apply the audio snap to a word-cut plan.
 *
 * Only a **character-count** plan needs rescuing. When the line carries word
 * timings, those times came from the engine that heard the words — they are
 * already the exact start and end, and nudging them by even 50 ms would make
 * an exact cut less exact. So `approx` is the switch: guessed times are pulled
 * onto the nearest quiet gap, timed words are left alone.
 *
 * The plan's parts are welded to its two boundaries: the prefix must end
 * exactly where the cut begins and the suffix must start where it ends, or
 * the three rows would overlap the audio they name. So the edges are moved
 * here, in one place, instead of by each caller.
 */
export function snapPlanToAudio(
  plan: WordCutPlan,
  wave: WaveformData | null | undefined,
  lineStartSec: number,
  lineEndSec: number
): WordCutPlan {
  if (!plan.approx || !wave?.peaks?.length) return plan;

  const from = snapToGap(wave, plan.fromSec, { windowSec: 0.35 });
  const to = snapToGap(wave, plan.toSec, { windowSec: 0.35 });
  if (!from.snapped && !to.snapped) return plan;

  const fromSec = clamp(from.sec, lineStartSec, lineEndSec);
  const toSec = clamp(to.sec, lineStartSec, lineEndSec);
  const original = plan.toSec - plan.fromSec;
  // Both edges can find the same pause, or one can cross the other on a very
  // short word. Falling back to the transcript's own times is better than
  // shipping a zero-length cut.
  if (!(toSec - fromSec >= Math.min(0.06, original * 0.5))) return plan;

  return {
    ...plan,
    snapped: true,
    fromSec,
    toSec,
    prefix: plan.prefix ? { ...plan.prefix, toSec: fromSec } : null,
    cut: { ...plan.cut, fromSec, toSec },
    suffix: plan.suffix ? { ...plan.suffix, fromSec: toSec } : null
  };
}
