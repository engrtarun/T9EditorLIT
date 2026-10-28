import type { TranscriptLine } from './types';

/**
 * Pure edit-timeline logic. Kept free of Svelte runes so it can be unit
 * tested directly with `node --test` — the drag-and-drop maths is the risky
 * part, so it must not depend on a browser.
 *
 * The **timeline is the master**. `buildSegments()` tiles the whole source
 * from 0 to its duration: kept material, cut material and dead air the
 * transcript never covered all become segments, so nothing ever hides. A cut
 * does not delete anything — it flips `state` to `'cut'` and the block stays
 * on screen at full width (red for a user/AI cut, grey for silence). The
 * transcript hangs off the same segments, which is what keeps the two in
 * step in both directions.
 */

/** A segment either survives into the final video or is cut away. */
export type SegmentState = 'keep' | 'cut';

/** Why a segment is cut — `user` paints red, `silence` paints grey. */
export type CutReason = 'user' | 'silence';

export interface Segment {
  id: string;
  /** Source start / end (seconds into the original video). */
  startSec: number;
  endSec: number;
  lines: TranscriptLine[];
  /** `cut` stays on the timeline as a block instead of vanishing. */
  state: SegmentState;
  /** Set on `cut` segments only — drives red vs grey. */
  reason?: CutReason;
}

/**
 * Two kept lines closer together than this are one clip, not two: a
 * hairline pause is part of the sentence around it. It is also the width
 * below which an *uncovered* pause is folded back into the clip instead of
 * showing up as a sliver of dead air.
 */
const GAP_SEC = 0.35;

export interface BuildSegmentsOpts {
  /**
   * Time ranges the user cut while no transcript covered them. They are the
   * only truth for a transcript-less project, and they keep a cut red even
   * after a transcript arrives but fails to cover that stretch.
   */
  cutSpans?: ReadonlyArray<readonly [number, number]>;
  /** Source seconds the user split at — each one forces a clip boundary. */
  splitMarks?: readonly number[];
  /** Source length, so the timeline can tile the whole file. */
  sourceDurationSec?: number;
}

/**
 * Group the transcript (and any time-based cuts) into contiguous segments.
 *
 * Every boundary — a line edge, a cut span, a manual split — slices the
 * source; neighbouring slices with the same fate are glued back together
 * into one clip. A region no line covers is dead air: grey and out of the
 * final video once a transcript exists, kept while there is none (the source
 * *is* the clip then).
 */
export function buildSegments(lines: TranscriptLine[], opts: BuildSegmentsOpts = {}): Segment[] {
  const spans = opts.cutSpans ?? [];
  const forced = opts.splitMarks ?? [];
  const dur = Math.max(0, opts.sourceDurationSec ?? 0);
  const hasLines = lines.length > 0;

  /* 1 — every moment where a clip's fate can change becomes a boundary. */
  const raw: number[] = [];
  const push = (t: number) => {
    if (!Number.isFinite(t) || t < 0) return;
    if (dur > 0 && t > dur) return;
    raw.push(t);
  };
  if (dur > 0) {
    push(0);
    push(dur);
  }
  for (const l of lines) {
    push(l.startSec);
    push(l.endSec);
  }
  for (const [a, b] of spans) {
    push(a);
    push(b);
  }
  for (const m of forced) push(m);
  if (raw.length < 2) return [];

  raw.sort((x, y) => x - y);
  const bounds: number[] = [];
  for (const t of raw) {
    if (!bounds.length || t - bounds[bounds.length - 1] > 1e-6) bounds.push(t);
  }
  if (bounds.length < 2) return [];
  const n = bounds.length - 1;

  const lower = (t: number) => {
    let lo = 0;
    let hi = bounds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bounds[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const upper = (t: number) => {
    let lo = 0;
    let hi = bounds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bounds[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /** Mark whole slices `[from, to)` — both ends are boundary indices. */
  const paint = (from: number, to: number, arr: Uint8Array) => {
    const a = Math.max(0, from);
    const z = Math.min(n, to);
    for (let k = a; k < z; k++) arr[k] = 1;
  };

  /* 2 — who has a claim on each slice: the user's spans, then the lines. */
  const spanHit = new Uint8Array(n);
  const keepHit = new Uint8Array(n);
  const cutHit = new Uint8Array(n);
  /** A cut line that is not silence — fumble, repeat, a wrong example. */
  const cutLoud = new Uint8Array(n);

  for (const [a, b] of spans) {
    if (b > a) paint(lower(a), upper(b) - 1, spanHit);
  }
  for (const l of lines) {
    if (!(l.endSec > l.startSec)) continue;
    const from = lower(l.startSec);
    const to = upper(l.endSec) - 1;
    if (l.keep === 'keep') {
      paint(from, to, keepHit);
    } else {
      paint(from, to, cutHit);
      if (l.flag !== 'silence') paint(from, to, cutLoud);
    }
  }

  /* A manual split is a promise: the two halves become two clips, even when
     nothing separates them yet. Without this the glue pass below would put a
     hairline right back together and `S` would only draw a divider. */
  const splitAfter = new Uint8Array(n);
  for (const m of forced) {
    const at = lower(m);
    if (at > 0 && at < bounds.length && bounds[at] === m) splitAfter[at - 1] = 1;
  }

  const states: SegmentState[] = new Array<SegmentState>(n);
  const reasons: CutReason[] = new Array<CutReason>(n);
  const covered = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (keepHit[k]) {
      // A kept line always wins: restoring a row must restore the clip even
      // when a time cut once covered it.
      states[k] = 'keep';
      reasons[k] = 'silence';
      covered[k] = 1;
    } else if (spanHit[k]) {
      states[k] = 'cut';
      reasons[k] = 'user';
      covered[k] = 1;
    } else if (cutHit[k]) {
      states[k] = 'cut';
      reasons[k] = cutLoud[k] ? 'user' : 'silence';
      covered[k] = 1;
    } else {
      // provisional: resolved with its neighbours in the pass below
      states[k] = 'cut';
      reasons[k] = 'silence';
    }
  }

  /* 3 — dead air. Without a transcript the source itself is the clip, so
     only the user's own time cuts carve anything out of it. With one, an
     uncovered stretch is silence the transcription never spoke for: grey,
     and absent from the final video exactly as it was before. */
  if (hasLines) {
    let k = 0;
    while (k < n) {
      if (covered[k]) {
        k++;
        continue;
      }
      let z = k;
      while (z < n && !covered[z]) z++;
      const hairline =
        bounds[z] - bounds[k] <= GAP_SEC &&
        k > 0 &&
        states[k - 1] === 'keep' &&
        z < n &&
        states[z] === 'keep';
      if (!hairline) {
        for (let i = k; i < z; i++) {
          states[i] = 'cut';
          reasons[i] = 'silence';
        }
      } else {
        for (let i = k; i < z; i++) {
          states[i] = 'keep';
          reasons[i] = 'silence';
        }
      }
      k = z;
    }
  } else {
    for (let k = 0; k < n; k++) {
      if (covered[k]) continue;
      states[k] = 'keep';
      reasons[k] = 'silence';
    }
  }

  /* 4 — glue neighbouring slices that share a fate into one clip, stopping
     at every manual split. */
  const segs: Segment[] = [];
  let k = 0;
  while (k < n) {
    const state = states[k];
    const reason = reasons[k];
    let z = k + 1;
    while (z < n && states[z] === state && reasons[z] === reason && !splitAfter[z - 1]) z++;
    const startSec = bounds[k];
    const endSec = bounds[z];
    if (endSec > startSec) {
      const seg: Segment = { id: '', startSec, endSec, lines: [], state };
      if (state === 'cut') seg.reason = reason;
      segs.push(seg);
    }
    k = z;
  }
  if (!segs.length) return [];

  /* 5 — hang each transcript row off the clip that owns its midpoint. */
  for (const l of lines) {
    const at = (l.startSec + l.endSec) / 2;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].endSec <= at) lo = mid + 1;
      else hi = mid;
    }
    segs[lo]?.lines.push(l);
  }

  /* 6 — ids. A clip with a transcript is keyed by its first row (stable when
     an earlier clip goes); a clip born before any transcript exists is keyed
     by its start time, so cutting one in half never renumbers the other. */
  for (const s of segs) {
    s.id = s.lines.length ? `seg-${s.lines[0].id}` : `seg-t${Math.round(s.startSec * 1000)}`;
  }
  return segs;
}

/** Apply the user's drag order. Segments missing from the order keep their natural place. */
export function orderSegments(segs: Segment[], order: string[]): Segment[] {
  if (!order.length) return segs;
  const byId = new Map(segs.map((s) => [s.id, s]));
  const out: Segment[] = [];
  const used = new Set<string>();
  for (const id of order) {
    const s = byId.get(id);
    if (s && !used.has(id)) {
      out.push(s);
      used.add(id);
    }
  }
  for (const s of segs) if (!used.has(s.id)) out.push(s);
  return out;
}

/**
 * Where each segment starts on the **timeline** axis.
 *
 * Cut blocks occupy their full width here — that is what makes the timeline
 * an honest mirror of the source. The final video's own axis is
 * `editDuration()`, which counts the kept segments only.
 */
export function computeOffsets(segs: Segment[]): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  let at = 0;
  for (const s of segs) {
    const len = Math.max(0, s.endSec - s.startSec);
    out.set(s.id, { start: at, end: at + len });
    at += len;
  }
  return out;
}

/** Total length of the final video — kept segments only, cut blocks excluded. */
export function editDuration(segs: Segment[]): number {
  return segs.reduce((t, s) => t + (s.state === 'cut' ? 0 : Math.max(0, s.endSec - s.startSec)), 0);
}

/** Total length of the timeline — cut blocks included, so nothing hides. */
export function timelineDuration(segs: Segment[]): number {
  return segs.reduce((t, s) => t + Math.max(0, s.endSec - s.startSec), 0);
}

/**
 * The transcript rows in final-video order. Every row lives inside exactly
 * one segment, so the panel mirrors the timeline by construction — a cut row
 * sits under its own red block instead of being tucked away.
 */
export function orderLines(segs: Segment[], lines: TranscriptLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  const seen = new Set<string>();
  for (const s of segs) {
    for (const l of s.lines) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(l);
    }
  }
  // A row no segment claimed (a source time outside the tiled range) still
  // belongs in the panel — dropping it would hide transcript content.
  for (const l of lines) if (!seen.has(l.id)) out.push(l);
  return out;
}

/** Source time → timeline position (null when it lies outside the source). */
export function editTimeAt(
  segs: Segment[],
  offsets: Map<string, { start: number; end: number }>,
  sourceSec: number
): number | null {
  for (const s of segs) {
    const off = offsets.get(s.id);
    if (!off) continue;
    if (sourceSec >= s.startSec && sourceSec < s.endSec)
      return off.start + (sourceSec - s.startSec);
  }
  return null;
}

/** Timeline position → source time. */
export function sourceAt(
  segs: Segment[],
  offsets: Map<string, { start: number; end: number }>,
  editSec: number
): number | null {
  for (const s of segs) {
    const off = offsets.get(s.id);
    if (!off) continue;
    if (editSec >= off.start && editSec < off.end) return s.startSec + (editSec - off.start);
  }
  return null;
}

/**
 * Where a dragged segment should land, given the pointer position on the
 * timeline. `others` is the segment list *without* the dragged one, so the
 * returned index is an index into that reduced list.
 */
export function dropIndex(
  segs: Segment[],
  offsets: Map<string, { start: number; end: number }>,
  draggedId: string,
  editSec: number
): number {
  const others = segs.filter((s) => s.id !== draggedId);
  for (let i = 0; i < others.length; i++) {
    const off = offsets.get(others[i].id);
    if (!off) continue;
    if (editSec < off.start + (off.end - off.start) / 2) return i;
  }
  return others.length;
}

/**
 * Where a **new** clip should be inserted, given the extra-clip layout on the
 * bottom timeline and the pointer's position on that axis.
 *
 * Extra clips sit back to back after the main strip, so this is the same
 * midpoint rule `dropIndex` uses: pass a clip's midpoint and the new clip
 * goes after it. Anywhere over the main cut (before the first extra) means
 * "insert at the front"; past the last clip means "append".
 */
export function insertSlotAt(
  layout: ReadonlyArray<{ start: number; end: number }>,
  editSec: number
): number {
  for (let i = 0; i < layout.length; i++) {
    const r = layout[i];
    if (editSec < r.start + (r.end - r.start) / 2) return i;
  }
  return layout.length;
}

/** Move a segment inside the id order, returning the new order. */
export function moveInOrder(order: string[], fromId: string, toIndex: number): string[] {
  const from = order.indexOf(fromId);
  if (from < 0) return order;
  const rest = order.filter((id) => id !== fromId);
  const to = Math.max(0, Math.min(rest.length, toIndex));
  rest.splice(to, 0, fromId);
  return rest;
}
