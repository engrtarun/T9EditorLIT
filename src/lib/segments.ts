/**
 * Convert transcript keep/cut decisions into kept time ranges for the export
 * planner. Runs entirely on the frontend — no media I/O.
 */

export interface TimeRange {
  start: number;
  end: number;
}

export interface SegmentSummary {
  keptSecs: number;
  cutSecs: number;
  segmentCount: number;
}

/**
 * Build the kept segments from the transcript lines.
 *
 * - Lines with `keep: true` are concatenated into ranges.
 * - Adjacent kept lines are merged into a single continuous segment.
 * - The result is clamped to [0, durationSecs] and zero-length ranges are dropped.
 */
export function segmentsFromTranscript(
  lines: ReadonlyArray<{ startSecs: number; endSecs: number; keep: boolean }>,
  durationSecs: number,
): TimeRange[] {
  if (durationSecs <= 0 || lines.length === 0) return [];

  const clamped = lines
    .filter((l) => l.keep)
    .map((l) => ({
      start: Math.max(0, Math.min(l.startSecs, durationSecs)),
      end: Math.max(0, Math.min(l.endSecs, durationSecs)),
    }))
    .filter((r) => r.end - r.start > 1e-6)
    .sort((a, b) => a.start - b.start);

  if (clamped.length === 0) return [];

  const merged: TimeRange[] = [];
  let cur = clamped[0];
  for (let i = 1; i < clamped.length; i++) {
    const next = clamped[i];
    if (next.start - cur.end <= 1e-3) {
      cur = { start: cur.start, end: Math.max(cur.end, next.end) };
    } else {
      merged.push(cur);
      cur = next;
    }
  }
  merged.push(cur);

  return merged;
}

/**
 * Summary stats for the export panel.
 */
export function summarizeSegments(segments: TimeRange[], durationSecs: number): SegmentSummary {
  const keptSecs = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  const cutSecs = Math.max(0, durationSecs - keptSecs);
  return {
    keptSecs,
    cutSecs,
    segmentCount: segments.length,
  };
}

export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "--:--";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.floor((secs % 1) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`;
  return `${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`;
}
