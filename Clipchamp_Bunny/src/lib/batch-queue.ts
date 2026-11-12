import { estimateForDuration } from './transcript-plan.ts';

/**
 * Batch day — thirty files, one queue, one API call at a time.
 *
 * The complaint this answers: "30 voice-notes ek saath daale, aur kisi file ka
 * pata nahi chala." The old app could only queue chunks **inside one project**,
 * so thirty files meant thirty imports and hand-driven clicking, and nothing
 * stopped an impatient user from firing several projects at once.
 *
 * The model here is deliberately boring:
 *
 *   * every file is one row with an honest status,
 *   * the worker takes the **next selected queued row** and never runs two,
 *   * a file's cost is shown before the user commits (`estimateForDuration`),
 *   * the queue is persisted, so a closed app does not lose the list.
 *
 * Pure on purpose: ordering, totals and the stored-JSON round trip are the
 * parts that must not drift, so they live here with tests instead of inside a
 * reactive store or a component.
 */

/** One queued file. */
export interface BatchItem {
  id: string;
  path: string;
  name: string;
  status: BatchStatus;
  /** The user may untick a file before the run reaches it. */
  selected: boolean;
  durationSecs: number;
  sizeBytes: number;
  /** Last failure, verbatim — the panel shows it, it is not swallowed. */
  error?: string;
  doneChunks: number;
  totalChunks: number;
  lines: number;
}

export type BatchStatus = 'probing' | 'queued' | 'running' | 'done' | 'cached' | 'failed';

/** Thirty is the stated case; sixty is the ceiling that keeps the list sane. */
export const MAX_BATCH_FILES = 60;

/** Stored queue key (SQLite `kv`, localStorage in a dev build). */
export const BATCH_QUEUE_KEY = 't9-editor-lit.batch-queue.v1';

const STATUSES: BatchStatus[] = ['probing', 'queued', 'running', 'done', 'cached', 'failed'];

/** `D:\voice\note 3.m4a` -> `note 3`. */
export function batchName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, '') || base;
}

/** A row id. Not the path: a path is a terrible key for a list that can move. */
export function randomBatchId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function makeBatchItem(path: string, id: string): BatchItem {
  return {
    id,
    path,
    name: batchName(path),
    // A fresh row has no duration yet; `probing` is what the picker promises
    // while ffprobe runs, and the worker re-probes if the app closed first.
    status: 'probing',
    selected: true,
    durationSecs: 0,
    sizeBytes: 0,
    doneChunks: 0,
    totalChunks: 0,
    lines: 0
  };
}

function finite(raw: unknown, fallback = 0): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Read a stored queue back.
 *
 * A row whose path is gone is still kept — the file may be on a drive that is
 * not mounted right now, and silently deleting the user's list is worse than
 * showing a row the worker will fail honestly. Rows that were mid-run are put
 * back in `queued`: the process that owned `running` no longer exists.
 */
export function parseBatchQueue(raw: unknown): BatchItem[] {
  if (!raw) return [];
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const list = (data as { items?: unknown })?.items;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const items: BatchItem[] = [];
  for (const row of list.slice(0, MAX_BATCH_FILES)) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const path = typeof r.path === 'string' ? r.path : '';
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const status = STATUSES.includes(r.status as BatchStatus)
      ? (r.status as BatchStatus)
      : 'queued';
    items.push({
      id: typeof r.id === 'string' && r.id ? r.id : path,
      path,
      name: typeof r.name === 'string' && r.name ? r.name : batchName(path),
      status: status === 'running' || status === 'probing' ? 'queued' : status,
      selected: r.selected !== false,
      durationSecs: finite(r.durationSecs),
      sizeBytes: finite(r.sizeBytes),
      error: typeof r.error === 'string' && r.error ? r.error : undefined,
      doneChunks: finite(r.doneChunks),
      totalChunks: finite(r.totalChunks),
      lines: finite(r.lines)
    });
  }
  return items;
}

export function serializeBatchQueue(items: BatchItem[]): string {
  return JSON.stringify({ items });
}

/** What the ticked files will cost, in the units the transcript panel uses. */
export function batchTotals(items: BatchItem[]): {
  files: number;
  calls: number;
  audioSecs: number;
  etaSecs: number;
} {
  let files = 0;
  let calls = 0;
  let audioSecs = 0;
  let etaSecs = 0;
  for (const item of items) {
    if (!item.selected || item.status === 'done' || item.status === 'cached') continue;
    files++;
    const est = estimateForDuration(item.durationSecs);
    calls += est.calls;
    audioSecs += est.audioSecs;
    etaSecs += est.etaSecs;
  }
  return { files, calls, audioSecs, etaSecs };
}

/** The next file the worker should take, in list order (top to bottom). */
export function nextQueued(items: BatchItem[]): BatchItem | null {
  return items.find((i) => i.selected && i.status === 'queued') ?? null;
}

/** `3 / 30` — how the queue position is written, done files included. */
export function batchPosition(items: BatchItem[], id: string): { at: number; of: number } | null {
  const selected = items.filter((i) => i.selected);
  const at = selected.findIndex((i) => i.id === id);
  if (at < 0) return null;
  return { at: at + 1, of: selected.length };
}

/** Counts for the panel header: finished (done or cached) out of selected. */
export function batchProgress(items: BatchItem[]): { done: number; total: number } {
  const selected = items.filter((i) => i.selected);
  const done = selected.filter((i) => i.status === 'done' || i.status === 'cached').length;
  return { done, total: selected.length };
}

/** True when at least one ticked row still has work. */
export function batchHasWork(items: BatchItem[]): boolean {
  return items.some((i) => i.selected && i.status === 'queued');
}
