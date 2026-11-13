import type { AudioChunk, TranscriptLine } from './types';

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

/**
 * The chunks a `[from, to]` request must buy.
 *
 * Whisper is called per chunk, so a range is a question about chunks, not
 * seconds. Half-open overlap on purpose: a chunk that ends exactly at `from`
 * lies behind the range and one that starts exactly at `to` lies ahead of it,
 * so "12:00-14:00" buys the chunks that hold those minutes and nothing else.
 * Done chunks are excluded — their words are already in SQLite.
 */
export function spansInRange(plan: TranscriptPlan, from: number, to: number): ChunkSpan[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const done = new Set(plan.done);
  return plan.spans.filter((s) => !done.has(s.index) && s.endSec > lo && s.startSec < hi);
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

/**
 * The storage key for one source's plan.
 *
 * Shared by the editor's transcript panel and the batch queue: the two must
 * look at the *same* plan, or a batch run would start from chunk 0 on a file
 * the user had already half-transcribed. Kept here so neither side can drift
 * from the other's spelling.
 */
export function transcriptPlanKey(sourcePath: string): string {
  return `t9-editor-lit.transcript-plan.${sourcePath}`;
}

/**
 * Did a chunk fail because the network/daemon was unreachable (Case 10)?
 *
 * The plan footer may only say "offline" when there is evidence: a fetch that
 * never reached the daemon, a refused loopback connection, or a DNS failure.
 * A bad audio file, a 25 MB rejection, a 429 rate limit or a 5xx from a
 * running daemon keep their own honest wording — calling those "offline"
 * would send the user to check the router for nothing.
 */
export function isOfflineError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('fetch failed') ||
    m.includes('networkerror') ||
    m.includes('network error') ||
    m.includes('could not connect') ||
    m.includes('connection refused') ||
    m.includes('connection reset') ||
    m.includes('econnrefused') ||
    m.includes('enotfound') ||
    m.includes('err_internet') ||
    m.includes('unreachable')
  );
}

/* ── Case 9: the overlap between two chunks ─────────────────────────────── */

/** Text for comparison: case, punctuation and spacing ignored. */
function fingerprintOfText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance, abandoned once it is clearly above `cap`. */
function editDistance(a: string, b: string, cap: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost));
    }
    previous = row;
  }
  return previous[b.length];
}

/**
 * Did the two chunks hear the same words?
 *
 * Whisper segments the same second of audio differently depending on what
 * else is in the chunk, so exact equality is too strict. A truncated word
 * ("deci" vs "decision") shows up as one string containing the other; other
 * drift is allowed two character edits.
 */
function similarText(a: string, b: string): boolean {
  const left = fingerprintOfText(a);
  const right = fingerprintOfText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  return editDistance(left, right, 2) <= 2;
}

/**
 * Merge the next chunk's lines into the transcript **without duplicating the
 * overlap**.
 *
 * Rust now gives adjacent chunks `overlapSecs` of shared audio on both sides
 * of a cut (see `audio::plan_spans`). Whisper transcribes that audio twice,
 * so the same sentence arrives from both sides with slightly different
 * timestamps and segmentation. This function is the arbiter:
 *
 * * a line that starts after the previous chunk's end is new, keep it,
 * * a line in the overlap is a duplicate when a nearby previous line says
 *   almost the same thing — keep the **longer** text (the side that heard the
 *   whole word), preserve the previous line's id and keep/cut decision,
 * * when nothing matches, keep both. A duplicated word costs one line the
 *   user can cut; a missing word is unrecoverable.
 *
 * Pure and order-independent: the result is sorted by source time, so a
 * resumed plan that transcribes chunk 7 before chunk 2 still reads correctly.
 */
export function reconcileBoundary(
  previous: TranscriptLine[],
  next: TranscriptLine[],
  overlapSecs = 2.0
): TranscriptLine[] {
  if (!previous.length) return [...next].sort((a, b) => a.startSec - b.startSec);
  if (!next.length) return [...previous];

  const first = next.reduce((min, line) => Math.min(min, line.startSec), Infinity);
  // The previous chunk that actually touches this one, not some later chunk
  // that a resume already finished.
  const prevEnd = previous
    .filter((line) => line.startSec <= first + 0.75)
    .reduce((end, line) => Math.max(end, line.endSec), 0);
  // A duplicated line can start before the cut (the previous chunk's last
  // segment may begin well before its end), so the window reaches back a few
  // overlaps instead of starting exactly at `prevEnd - overlap`.
  const windowStart = prevEnd - Math.max(overlapSecs * 6, 12);

  const result = [...previous];
  for (const line of next) {
    if (line.startSec >= prevEnd + 0.75 || line.startSec < windowStart) {
      result.push(line);
      continue;
    }
    let match: TranscriptLine | undefined;
    for (let i = result.length - 1; i >= 0; i--) {
      const candidate = result[i];
      if (candidate.startSec > line.endSec + 1.5) continue;
      if (line.startSec > candidate.endSec + 1.5) break;
      if (Math.abs(candidate.startSec - line.startSec) > 2.5) continue;
      if (!similarText(candidate.text, line.text)) continue;
      match = candidate;
      break;
    }
    if (!match) {
      result.push(line);
      continue;
    }
    if (fingerprintOfText(line.text).length > fingerprintOfText(match.text).length) {
      match.text = line.text;
      match.endSec = Math.max(match.endSec, line.endSec);
      if (line.words?.length) match.words = line.words;
    }
  }
  return result.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}
