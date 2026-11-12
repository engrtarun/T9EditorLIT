import type { AudioChunk } from './types';

/**
 * A transcript is bought one chunk at a time.
 *
 * The old flow posted every chunk of the source in one job: a 49-minute import
 * meant ten Whisper calls before the user saw a single word, and a silent hour
 * was paid for in full. The plan is the honest alternative — it knows which
 * chunks exist, which are already transcribed and saved, and exactly what the
 * next click will cost.
 *
 * Pure on purpose: the arithmetic that decides "how much is left" is the part
 * that must not drift between the panel, the cost line and the retry button,
 * so it lives here with tests instead of inside a component.
 */

/** One chunk's place in the source, in source seconds. */
export interface ChunkSpan {
  index: number;
  startSec: number;
  endSec: number;
}

/** The whole job: every chunk, and the ones already on disk. */
export interface TranscriptPlan {
  spans: ChunkSpan[];
  /** Positions already transcribed and saved — a silent chunk counts. */
  done: number[];
}

/** What the next clicks would cost, in the units the user thinks in. */
export interface PlanEstimate {
  /** Seconds of audio still to send. */
  audioSecs: number;
  /** Whisper calls still to make (one per chunk). */
  calls: number;
  /** Rough wall-clock wait. */
  etaSecs: number;
}

/**
 * Whisper-large on Groq runs around 5x realtime; 0.2 of the audio length is a
 * deliberately pessimistic wall-clock estimate (plus network). A promise that
 * is beaten is worth more than one that is missed.
 */
const ETA_RATIO = 0.2;

/** Even a 20-second clip has upload, queue and model warm-up. */
const MIN_ETA_SECS = 20;

export function planFromChunks(chunks: AudioChunk[]): TranscriptPlan {
  return {
    spans: chunks.map((c) => ({
      index: c.index,
      startSec: c.offsetSecs,
      endSec: c.offsetSecs + (c.durationSecs || 0)
    })),
    done: []
  };
}

/**
 * Record a chunk as transcribed.
 *
 * Silent chunks are marked done too: the API ran, the answer was "no words",
 * and re-sending it on the next click would buy the same silence again.
 */
export function markDone(plan: TranscriptPlan, index: number): TranscriptPlan {
  if (plan.done.includes(index)) return plan;
  return { ...plan, done: [...plan.done, index].sort((a, b) => a - b) };
}

export function pendingSpans(plan: TranscriptPlan): ChunkSpan[] {
  const done = new Set(plan.done);
  return plan.spans.filter((s) => !done.has(s.index));
}

/** The chunk the next click would transcribe, or null when nothing is left. */
export function nextSpan(plan: TranscriptPlan): ChunkSpan | null {
  return pendingSpans(plan)[0] ?? null;
}

export function isPlanComplete(plan: TranscriptPlan): boolean {
  return pendingSpans(plan).length === 0;
}

/** Seconds of audio still to send — the number the cost line is built from. */
export function pendingSecs(plan: TranscriptPlan): number {
  return pendingSpans(plan).reduce((n, s) => n + Math.max(0, s.endSec - s.startSec), 0);
}

export function estimatePlan(plan: TranscriptPlan): PlanEstimate {
  const pending = pendingSpans(plan);
  const audioSecs = pending.reduce((n, s) => n + Math.max(0, s.endSec - s.startSec), 0);
  return {
    audioSecs,
    calls: pending.length,
    etaSecs: pending.length ? Math.max(MIN_ETA_SECS, Math.round(audioSecs * ETA_RATIO)) : 0
  };
}

/**
 * What a *fresh* transcript would cost, before any chunk exists.
 *
 * The panel shows this under the generate button: ffprobe already knows the
 * duration, and the Rust splitter's default segment is 300 s, so the estimate
 * the user reads before the first click matches the plan they get after it.
 * No audio is touched — this is arithmetic on a duration.
 */
export function estimateForDuration(durationSecs: number, segmentSecs = 300): PlanEstimate {
  const total = Math.max(0, durationSecs);
  if (!total) return { audioSecs: 0, calls: 0, etaSecs: 0 };
  const seg = segmentSecs > 0 ? segmentSecs : 300;
  return {
    audioSecs: total,
    calls: Math.max(1, Math.ceil(total / seg)),
    etaSecs: Math.max(MIN_ETA_SECS, Math.round(total * ETA_RATIO))
  };
}

/**
 * Re-hydrate a plan read back from localStorage.
 *
 * Storage is user-writable and survives upgrades, so nothing in it is trusted:
 * a malformed span would otherwise make `nextSpan` return a chunk that does not
 * exist, and the run would fail before it asked the daemon anything.
 */
export function parsePlan(raw: unknown): TranscriptPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { spans?: unknown; done?: unknown };
  if (!Array.isArray(obj.spans) || !obj.spans.length) return null;

  const spans: ChunkSpan[] = [];
  for (const s of obj.spans) {
    if (!s || typeof s !== 'object') continue;
    const { index, startSec, endSec } = s as Record<string, unknown>;
    if (typeof index !== 'number' || !Number.isFinite(index)) continue;
    if (typeof startSec !== 'number' || !Number.isFinite(startSec)) continue;
    if (typeof endSec !== 'number' || !Number.isFinite(endSec)) continue;
    spans.push({ index, startSec, endSec });
  }
  if (!spans.length) return null;
  // The panel's arithmetic assumes the array is in source order.
  spans.sort((a, b) => a.index - b.index);

  const known = new Set(spans.map((s) => s.index));
  const done: number[] = [];
  if (Array.isArray(obj.done)) {
    for (const d of obj.done) {
      if (typeof d === 'number' && known.has(d) && !done.includes(d)) done.push(d);
    }
  }
  done.sort((a, b) => a - b);
  return { spans, done };
}
