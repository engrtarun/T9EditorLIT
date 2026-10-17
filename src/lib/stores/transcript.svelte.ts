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
  progress = $state<string | null>(null);
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
    this.error = null;
    this.sourcePath = sourcePath;
    try {
      const lines = await transcribeSource(sourcePath, (p) => {
        this.progress = p.stage;
      });
      this.lines = lines;
      this.undoStack = [];
      this.redoStack = [];
      this.progress = null;
    } catch (err) {
      this.error = errorMessage(err);
      this.progress = null;
    } finally {
      this.transcribing = false;
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
