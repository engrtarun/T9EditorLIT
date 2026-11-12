/**
 * The batch transcription worker (Case 4: "30 files ek saath + Groq 429").
 *
 * One queue, one worker, **one API call at a time**. The bottleneck is Groq's
 * throughput, not this machine, so running files in parallel would only turn
 * a slow morning into a pile of 429s — and thirty FFmpeg children would break
 * the zero-RAM rule the rest of the app is built on.
 *
 * Everything is stored on disk as it happens:
 *   * the queue itself in SQLite `kv` (`BATCH_QUEUE_KEY`),
 *   * each file's chunk plan under the **same key the editor uses**
 *     (`transcriptPlanKey`), so a file started in the editor and finished in
 *     the batch (or the reverse) never pays for the same audio twice,
 *   * the words in the `transcripts` table, one chunk at a time.
 *
 * A file that fails does not stop the queue: it is marked `failed` with the
 * daemon's own words, and the next file starts. Thirty files with one broken
 * voice-note must still finish twenty-nine of them.
 */

import type { TranscriptLine } from '../types';
import { chunkSourceKey, toLineFlag } from '../cloud-contract';
import {
  BATCH_QUEUE_KEY,
  MAX_BATCH_FILES,
  batchName,
  makeBatchItem,
  nextQueued,
  parseBatchQueue,
  randomBatchId,
  serializeBatchQueue,
  type BatchItem
} from '../batch-queue';
import {
  isPlanComplete,
  markDone,
  nextSpan,
  parsePlan,
  planFromChunks,
  reconcileBoundary,
  transcriptPlanKey,
  type TranscriptPlan
} from '../transcript-plan';
import { NoSpeechError, runTranscription, type CloudSegment } from '../pipeline';
import {
  cleanChunkDir,
  defaultDbPath,
  extractAudioChunks,
  isTauri,
  loadTranscript,
  logAppEvent,
  probeMedia,
  rememberSourceFingerprint,
  removeAudioChunk,
  saveTranscript,
  sourceFingerprint,
  statsGet,
  statsSet,
  transcriptByHash
} from '../ipc';

/** A breath between files — one second keeps a 30-file run a polite guest. */
const BETWEEN_FILES_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toLines(segs: CloudSegment[]): TranscriptLine[] {
  return segs.map((s) => ({
    id: s.id,
    startSec: s.start_secs,
    endSec: s.end_secs,
    text: s.text,
    flag: toLineFlag(s.flag),
    keep: s.keep ? 'keep' : 'cut',
    confidence: 1,
    words: s.words?.map((w) => ({ word: w.word, start: w.start, end: w.end }))
  }));
}

function toSegments(lines: TranscriptLine[]): CloudSegment[] {
  return lines.map((l) => ({
    id: l.id,
    start_secs: l.startSec,
    end_secs: l.endSec,
    text: l.text,
    flag: l.flag,
    keep: l.keep === 'keep',
    words: l.words
  }));
}

/** SQLite rows → the same shape the daemon speaks, so one merge path remains. */
function fromRust(rows: Awaited<ReturnType<typeof loadTranscript>>): TranscriptLine[] {
  return rows.map((l) => ({
    id: l.id,
    startSec: l.startSecs,
    endSec: l.endSecs,
    text: l.text,
    flag: toLineFlag(l.flag),
    keep: l.keep ? 'keep' : 'cut',
    confidence: 1,
    words: l.words?.map((w) => ({ word: w.word, start: w.start, end: w.end }))
  }));
}

class BatchStore {
  /** The queue, top to bottom. Always the same order the user picked files in. */
  items = $state<BatchItem[]>([]);

  /** The queue panel is open (it stays open across screens; the worker is global). */
  open = $state(false);

  /** Collapsed to a one-line chip so it never blocks the editor. */
  minimized = $state(false);

  /** A run is in flight. */
  running = $state(false);

  /** The file the worker is on right now, for the "3/30" line. */
  currentId = $state<string | null>(null);

  /** Set by "Rok do": the worker stops after the file in flight. */
  private stop = false;

  /** One probe at a time; a second `add` queues behind the first. */
  private probing: Promise<void> = Promise.resolve();

  private save(): void {
    void statsSet(BATCH_QUEUE_KEY, serializeBatchQueue(this.items));
  }

  /** Read the persisted queue. Called once from the app root. */
  async hydrate(): Promise<void> {
    if (!isTauri()) return;
    const raw = await statsGet(BATCH_QUEUE_KEY).catch(() => null);
    if (!raw) return;
    const parsed = parseBatchQueue(raw);
    if (!parsed.length) return;
    // A row the old process left as `probing` has no duration; probe it again
    // so its cost estimate is real before the user starts the run.
    this.items = parsed;
    // Work that was queued when the app closed is not hidden behind a button:
    // the panel reopens with the list it was showing.
    if (parsed.some((i) => i.status === 'queued')) this.open = true;
    for (const item of this.items) {
      if (item.durationSecs <= 0) void this.enqueueProbe(item.id);
    }
  }

  /**
   * Add files to the queue.
   *
   * Duplicates are ignored (the same path twice is one row) and the list is
   * capped — a 300-file drop would be a different product decision, not a
   * bigger queue.
   */
  addPaths(paths: string[]): number {
    const known = new Set(this.items.map((i) => i.path));
    let added = 0;
    for (const path of paths) {
      if (!path || known.has(path)) continue;
      if (this.items.length >= MAX_BATCH_FILES) break;
      known.add(path);
      this.items.push(makeBatchItem(path, randomBatchId()));
      added++;
    }
    if (added) {
      this.open = true;
      this.minimized = false;
      this.save();
      for (const item of this.items) {
        if (item.status === 'probing' && item.durationSecs <= 0) void this.enqueueProbe(item.id);
      }
    }
    return added;
  }

  /** Probe behind whatever probe is already running, so FFprobe never storms. */
  private enqueueProbe(id: string): Promise<void> {
    this.probing = this.probing.then(() => this.probe(id)).catch(() => {});
    return this.probing;
  }

  private async probe(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    if (!isTauri()) {
      item.status = 'queued';
      return;
    }
    try {
      const info = await probeMedia(item.path);
      const still = this.items.find((i) => i.id === id);
      if (!still) return;
      still.durationSecs = info.durationSecs;
      still.sizeBytes = info.sizeBytes;
      still.status = still.status === 'probing' ? 'queued' : still.status;
      if (!still.name) still.name = batchName(still.path);
    } catch (e) {
      const still = this.items.find((i) => i.id === id);
      if (!still) return;
      // A file the probe cannot read is not silently dropped: the row stays,
      // says why, and is not selected for the run.
      still.status = 'failed';
      still.selected = false;
      still.error = e instanceof Error ? e.message : String(e);
    }
    this.save();
  }

  toggle(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status === 'running') return;
    item.selected = !item.selected;
    this.save();
  }

  /** Remove one row (and its place in the queue). */
  remove(id: string): void {
    if (this.running && this.currentId === id) return;
    this.items = this.items.filter((i) => i.id !== id);
    this.save();
  }

  /** Drop the rows that are finished, keeping anything the user may retry. */
  clearFinished(): void {
    this.items = this.items.filter((i) => i.status !== 'done' && i.status !== 'cached');
    this.save();
    if (!this.items.length) this.open = false;
  }

  /** "Rok do": the file in flight finishes, nothing after it starts. */
  stopRun(): void {
    this.stop = true;
  }

  /** Re-arm every failed/cached row so a second run tries them again. */
  requeueFailed(): void {
    for (const item of this.items) {
      if (item.status === 'failed' || item.status === 'cached') {
        item.status = 'queued';
        item.selected = true;
        item.error = undefined;
        item.doneChunks = 0;
        item.totalChunks = 0;
      }
    }
    this.save();
  }

  /**
   * Run the queue: sequential, resumable, and honest about each file.
   *
   * The panel reads `items` directly, so the "3/30, is file par chal raha hai"
   * line is the store's own state rather than a guessed progress bar.
   */
  async run(): Promise<void> {
    if (this.running) return;
    const db = await defaultDbPath().catch(() => '');
    if (!db) return;
    this.running = true;
    this.stop = false;
    try {
      while (!this.stop) {
        const item = nextQueued(this.items);
        if (!item) break;
        this.currentId = item.id;
        item.status = 'running';
        item.error = undefined;
        item.doneChunks = 0;
        item.totalChunks = 0;
        this.save();
        try {
          await this.transcribeOne(db, item);
        } catch (e) {
          item.status = 'failed';
          item.error = e instanceof Error ? e.message : String(e);
          logAppEvent('error', 'batch', `${item.path}: ${item.error}`);
        }
        // "Rok do" stopped inside the file: it keeps its finished chunks and
        // goes back to the queue, so the next run resumes instead of showing
        // a file that is "running" forever.
        if (item.status === 'running') item.status = 'queued';
        this.currentId = null;
        this.save();
        if (this.stop) break;
        await sleep(BETWEEN_FILES_MS);
      }
    } finally {
      this.running = false;
      this.currentId = null;
      this.stop = false;
      this.save();
    }
  }

  /** One file, start to finish. Every step is on disk before the next one. */
  private async transcribeOne(db: string, item: BatchItem): Promise<void> {
    const path = item.path;
    if (!item.durationSecs) {
      const info = await probeMedia(path);
      item.durationSecs = info.durationSecs;
      item.sizeBytes = info.sizeBytes;
    }
    if (item.durationSecs > 0 && item.durationSecs < 1) {
      throw new Error('Clip 1 second se chhota hai — Whisper kuch nahi sun sakta.');
    }

    // A file that already has words is free: never pay for it again.
    const existing = await loadTranscript(db, path).catch(() => []);
    const stored = await this.readPlan(path);
    if (existing.length && (!stored || isPlanComplete(stored))) {
      item.status = 'cached';
      item.lines = existing.length;
      return;
    }

    // Case 3: the same bytes under a new name already have a transcript.
    if (!existing.length) {
      const hash = await sourceFingerprint(path).catch(() => '');
      if (hash) {
        const hit = await transcriptByHash(db, hash).catch(() => null);
        if (hit?.lines?.length) {
          await saveTranscript(db, path, toSegments(fromRust(hit.lines)));
          await rememberSourceFingerprint(db, path, hash, item.sizeBytes).catch(() => {});
          item.status = 'cached';
          item.lines = hit.lines.length;
          return;
        }
      }
    }

    const chunks = await extractAudioChunks(path, undefined, undefined, chunkSourceKey(path));
    const fresh = planFromChunks(chunks);
    const known = new Set(fresh.spans.map((s) => s.index));
    let plan: TranscriptPlan = stored
      ? { spans: fresh.spans, done: stored.done.filter((i) => known.has(i)) }
      : fresh;
    this.writePlan(path, plan);

    item.totalChunks = plan.spans.length;
    item.doneChunks = plan.done.length;

    let lines = fromRust(existing);

    while (!this.stop) {
      const span = nextSpan(plan);
      if (!span) break;
      const chunk = chunks.find((c) => c.index === span.index);
      if (!chunk) {
        // A restored plan named a chunk this extraction does not have. Drop
        // the position instead of guessing at different audio.
        plan = markDone(plan, span.index);
        this.writePlan(path, plan);
        continue;
      }
      try {
        const res = await runTranscription(path, [chunk], (p) => {
          item.lines = lines.length + (p.lines ?? 0);
        });
        lines = reconcileBoundary(lines, toLines(res.segments));
        await saveTranscript(
          db,
          path,
          toSegments(lines).sort((a, b) => a.start_secs - b.start_secs)
        );
      } catch (e) {
        if (!(e instanceof NoSpeechError)) throw e;
        // Silence is an answer, not a failure: the chunk is paid for, so it
        // counts as done and the file is not retried for the same silence.
      }
      plan = markDone(plan, span.index);
      this.writePlan(path, plan);
      item.doneChunks = plan.done.length;
      item.lines = lines.length;
      // Case 6: the words are in SQLite, so this WAV has done its job.
      void removeAudioChunk(chunk.path).catch(() => false);
      this.save();
    }

    if (this.stop && !isPlanComplete(plan)) return;
    if (!isPlanComplete(plan)) return;

    this.writePlan(path, null);
    await cleanChunkDir(chunkSourceKey(path)).catch(() => 0);
    const hash = await sourceFingerprint(path).catch(() => '');
    if (hash) await rememberSourceFingerprint(db, path, hash, item.sizeBytes).catch(() => {});
    item.status = 'done';
    item.lines = lines.length;
  }

  /* ------------------------------------------------------------- plan store */

  private async readPlan(path: string): Promise<TranscriptPlan | null> {
    const raw = await statsGet(transcriptPlanKey(path)).catch(() => null);
    if (!raw) return null;
    try {
      return parsePlan(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private writePlan(path: string, plan: TranscriptPlan | null): void {
    void statsSet(transcriptPlanKey(path), plan ? JSON.stringify(plan) : '');
  }
}

export const batch = new BatchStore();
