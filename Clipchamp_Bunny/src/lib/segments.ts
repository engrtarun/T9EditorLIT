import type { TranscriptLine } from './types';

/**
 * Pure edit-timeline logic. Kept free of Svelte runes so it can be unit
 * tested directly with `node --test` — the drag-and-drop maths is the risky
 * part, so it must not depend on a browser.
 */

export interface Segment {
  id: string;
  /** Source start / end (seconds into the original video). */
  startSec: number;
  endSec: number;
  lines: TranscriptLine[];
}

/** Group the kept transcript lines into contiguous segments. */
export function buildSegments(lines: TranscriptLine[]): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  for (const line of lines) {
    if (line.keep === 'cut') {
      cur = null;
      continue;
    }
    if (!cur || line.startSec - cur.endSec > 0.35) {
      cur = {
        id: `seg-${segs.length}`,
        startSec: line.startSec,
        endSec: line.endSec,
        lines: []
      };
      segs.push(cur);
    }
    cur.lines.push(line);
    cur.endSec = Math.max(cur.endSec, line.endSec);
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

/** Where each segment starts on the edit (final-video) timeline. */
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

/** Total length of the final video. */
export function editDuration(segs: Segment[]): number {
  return segs.reduce((t, s) => t + Math.max(0, s.endSec - s.startSec), 0);
}

/**
 * The transcript rows in final-video order. A cut line is attached to the
 * segment it interrupts, so the panel mirrors the timeline exactly.
 */
export function orderLines(segs: Segment[], lines: TranscriptLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  const cutBySeg = new Map<string, TranscriptLine[]>();
  const orphans: TranscriptLine[] = [];

  for (const l of lines) {
    if (l.keep !== 'cut') continue;
    let target: string | null = null;
    for (const s of segs) {
      if (l.startSec >= s.startSec - 0.5 && l.startSec <= s.endSec + 0.6) {
        target = s.id;
        break;
      }
    }
    if (!target) {
      let best: string | null = null;
      let bestEnd = -Infinity;
      for (const s of segs) {
        if (s.endSec <= l.startSec + 0.2 && s.endSec > bestEnd) {
          bestEnd = s.endSec;
          best = s.id;
        }
      }
      target = best;
    }
    if (target) {
      const arr = cutBySeg.get(target) ?? [];
      arr.push(l);
      cutBySeg.set(target, arr);
    } else {
      orphans.push(l);
    }
  }

  for (const s of segs) {
    out.push(...s.lines);
    out.push(...(cutBySeg.get(s.id) ?? []));
  }
  out.push(...orphans);
  return out;
}

/** Source time → edit-timeline position (null when the source time is cut away). */
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

/** Edit-timeline position → source time. */
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

/** Move a segment inside the id order, returning the new order. */
export function moveInOrder(order: string[], fromId: string, toIndex: number): string[] {
  const from = order.indexOf(fromId);
  if (from < 0) return order;
  const rest = order.filter((id) => id !== fromId);
  const to = Math.max(0, Math.min(rest.length, toIndex));
  rest.splice(to, 0, fromId);
  return rest;
}
