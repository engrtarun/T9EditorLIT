/**
 * Transcript + cut decisions, backed by SQLite on disk.
 *
 * Only the lines currently needed are held in the heap; the store keeps the
 * full array for the loaded source because the Cut Panel renders a virtual
 * window over it. Even so, ~thousands of short strings for a 2-hour video is
 * tens of MB at most �?" acceptable next to a 5 GB media file, and it is
 * reloaded from disk on demand rather than kept resident across mode switches.
 */
import {
  errorMessage,
  defaultDbPath,
  detectSilence,
  loadTranscript,
  saveTranscript,
  setTranscriptKeep,
} from "../ipc";
import { transcribeSource } from "../transcription";
import type { TranscriptLine } from "../types";

class TranscriptStore {
  dbPath = $state<string | null>(null);
  sourcePath = $state<string | null>(null);
  lines = $state<TranscriptLine[]>([]);
  loading = $state(false);
  transcribing = $state(false);
  removingSilence = $state(false);
  silenceInfo = $state<string | null>(null);
  progress = $state<string | null>(null);
  progressCompleted = $state(0);
  progressTotal = $state(0);
  error = $state<string | null>(null);

  undoStack = $state<{ index: number; previous: boolean; next: boolean }[]>([]);
  redoStack = $state<{ index: number; previous: boolean; next: boolean }[]>([]);

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get hasTranscript(): boolean {
    return this.lines.length > 0;
  }

  get cutCount(): number {
    return this.lines.filter((l) => !l.keep).length;
  }

  get keptCount(): number {
    return this.lines.filter((l) => l.keep).length;
  }

  /** Lines autocorrect actually changed. */
  get fixedCount(): number {
    return this.lines.filter((l) => l.originalText).length;
  }

  /**
   * Lines the analyser flagged that are still marked keep.
   *
   * These are the interesting ones: the AI proposed a cut and the user has not
   * ruled on it yet. They render amber so they stand out from both a settled
   * keep and a settled cut.
   */
  get reviewCount(): number {
    return this.lines.filter((l) => l.keep && l.flag !== "none").length;
  }

  /** Resolve the default db path once. */
  async ensureDbPath(): Promise<string> {
    if (this.dbPath) return this.dbPath;
    const p = await defaultDbPath();
    this.dbPath = p;
    return p;
  }

  async load(sourcePath: string): Promise<void> {
    this.loading = true;
    this.error = null;
    this.sourcePath = sourcePath;
    try {
      const db = await this.ensureDbPath();
      this.lines = await loadTranscript(db, sourcePath);
      this.undoStack = [];
      this.redoStack = [];
    } catch (err) {
      this.error = errorMessage(err);
      this.lines = [];
    } finally {
      this.loading = false;
    }
  }

  async transcribe(sourcePath: string): Promise<void> {
    this.transcribing = true;
    this.progress = "starting";
    this.progressCompleted = 0;
    this.progressTotal = 0;
    this.error = null;
    this.sourcePath = sourcePath;
    try {
      const lines = await transcribeSource(sourcePath, (p) => {
        this.progress = p.stage;
        if (typeof p.completed === "number") this.progressCompleted = p.completed;
        if (typeof p.total === "number") this.progressTotal = p.total;
      });
      this.lines = lines;
      this.undoStack = [];
      this.redoStack = [];
      this.progress = null;
      this.progressCompleted = 0;
      this.progressTotal = 0;
    } catch (err) {
      this.error = errorMessage(err);
      this.progress = null;
      this.progressCompleted = 0;
      this.progressTotal = 0;
    } finally {
      this.transcribing = false;
    }
  }

  /**
   * Detect silent spans (dead air) in the source and mark the transcript lines
   * that sit inside them as cut.
   *
   * Deliberately conservative: a line is only removed when at least half of
   * its duration is silent, so a sentence that merely pauses mid-way keeps
   * its speech. Short inter-sentence breaths stay because `minSecs` sets the
   * floor on what counts as silence.
   */
  async removeSilence(
    sourcePath: string,
    noiseDb = -30,
    minSecs = 0.8,
  ): Promise<void> {
    this.removingSilence = true;
    this.silenceInfo = "detecting silence…";
    this.error = null;
    try {
      const ranges = await detectSilence(sourcePath, noiseDb, minSecs);
      const sorted = [...ranges].sort((a, b) => a.start - b.start);

      let cutLines = 0;
      let savedSecs = 0;
      this.lines = this.lines.map((l) => {
        if (!l.keep) return l;
        const dur = l.endSecs - l.startSecs;
        let silentTime = 0;
        for (const r of sorted) {
          const overlap = Math.max(0, Math.min(l.endSecs, r.end) - Math.max(l.startSecs, r.start));
          silentTime += overlap;
        }
        if (dur > 0 && silentTime / dur >= 0.5) {
          cutLines += 1;
          savedSecs += dur;
          return { ...l, keep: false, flag: "silence" as const };
        }
        return l;
      });

      // Persist the new keep/flag decisions so they survive a reload.
      await this.save();

      const secs = Math.round(savedSecs);
      this.silenceInfo =
        cutLines === 0
          ? sorted.length === 0
            ? "no long silences found"
            : `${sorted.length} silent span(s) found — all inside speech, nothing cut`
          : `removed ${cutLines} silent line(s) · ~${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} saved`;
    } catch (err) {
      this.error = errorMessage(err);
      this.silenceInfo = null;
    } finally {
      this.removingSilence = false;
    }
  }

  async save(): Promise<void> {
    if (!this.sourcePath || !this.dbPath) return;
    try {
      await saveTranscript(this.dbPath, this.sourcePath, this.lines);
    } catch (err) {
      this.error = errorMessage(err);
    }
  }

  async toggleKeep(index: number): Promise<void> {
    const line = this.lines[index];
    if (!line || !this.sourcePath) return;
    const next = !line.keep;
    // Optimistic update; SQLite is the source of truth on reload.
    this.lines[index] = { ...line, keep: next };
    this.undoStack = [...this.undoStack, { index, previous: line.keep, next }];
    this.redoStack = [];
    try {
      const db = await this.ensureDbPath();
      await setTranscriptKeep(db, this.sourcePath, line.id, next);
    } catch (err) {
      // Revert on failure.
      this.lines[index] = { ...line, keep: !next };
      this.undoStack = this.undoStack.slice(0, -1);
      this.error = errorMessage(err);
    }
  }

  cut(index: number): Promise<void> {
    const line = this.lines[index];
    if (!line || !line.keep) return Promise.resolve();
    return this.toggleKeep(index);
  }

  keep(index: number): Promise<void> {
    const line = this.lines[index];
    if (!line || line.keep) return Promise.resolve();
    return this.toggleKeep(index);
  }

  async undo(): Promise<void> {
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) return;
    const line = this.lines[entry.index];
    if (!line || !this.sourcePath) return;
    this.undoStack = this.undoStack.slice(0, -1);
    this.lines[entry.index] = { ...line, keep: entry.previous };
    this.redoStack = [...this.redoStack, entry];
    try {
      const db = await this.ensureDbPath();
      await setTranscriptKeep(db, this.sourcePath, line.id, entry.previous);
    } catch (err) {
      this.lines[entry.index] = { ...line, keep: entry.next };
      this.undoStack = [...this.undoStack, entry];
      this.redoStack = this.redoStack.slice(0, -1);
      this.error = errorMessage(err);
    }
  }

  async redo(): Promise<void> {
    const entry = this.redoStack[this.redoStack.length - 1];
    if (!entry) return;
    const line = this.lines[entry.index];
    if (!line || !this.sourcePath) return;
    this.redoStack = this.redoStack.slice(0, -1);
    this.lines[entry.index] = { ...line, keep: entry.next };
    this.undoStack = [...this.undoStack, entry];
    try {
      const db = await this.ensureDbPath();
      await setTranscriptKeep(db, this.sourcePath, line.id, entry.next);
    } catch (err) {
      this.lines[entry.index] = { ...line, keep: entry.previous };
      this.redoStack = [...this.redoStack, entry];
      this.undoStack = this.undoStack.slice(0, -1);
      this.error = errorMessage(err);
    }
  }

  clear(): void {
    this.lines = [];
    this.sourcePath = null;
    this.error = null;
    this.undoStack = [];
    this.redoStack = [];
  }
}

export const transcript = new TranscriptStore();
