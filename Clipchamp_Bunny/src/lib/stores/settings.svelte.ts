/**
 * User-settable app settings.
 *
 * Only the trash retention lives here today; the store is deliberately tiny so
 * a new setting is one field + one persist call. Values are kept in
 * `localStorage` because they are per-machine choices (like the panel sizes in
 * `layout`), not project data — SQLite would be overkill and would put a
 * machine preference next to the user's media records.
 *
 * The retention is in **days** and `0` means "never auto-delete".
 */

/** LocalStorage key. */
const TRASH_DAYS_KEY = 't9-editor-lit.trashDays';

/** LocalStorage key for the transport skip step. */
const SEEK_STEP_KEY = 't9-editor-lit.seekStep';

/** LocalStorage key for "call the AI transcript API on import". */
const AUTO_TRANSCRIBE_KEY = 't9-editor-lit.autoTranscribe';

/** The window the user asked for: a binned project is recoverable for 12 days. */
export const TRASH_DAYS_DEFAULT = 12;

/** Transport skip step in seconds — Clipchamp's default. */
export const SEEK_STEP_DEFAULT = 5;

/** Hard ceiling — a retention window of ten years is effectively "never". */
const TRASH_DAYS_MAX = 3650;

/** A step under half a second is one frame, not a skip. */
const SEEK_STEP_MIN = 0.5;
/** Longer than a minute is a jump, not a skip. */
const SEEK_STEP_MAX = 60;

/** Coerce anything localStorage hands back into a usable retention. */
function coerceDays(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return TRASH_DAYS_DEFAULT;
  return Math.min(n, TRASH_DAYS_MAX);
}

/** Coerce anything localStorage hands back into a usable skip step. */
function coerceStep(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return SEEK_STEP_DEFAULT;
  return Math.min(SEEK_STEP_MAX, Math.max(SEEK_STEP_MIN, Math.round(n * 10) / 10));
}

class SettingsStore {
  /** Days a binned project stays recoverable. `0` = never auto-delete. */
  trashRetentionDays = $state(TRASH_DAYS_DEFAULT);

  /** Seconds the transport buttons and `J` / `L` move the playhead. */
  seekStepSec = $state(SEEK_STEP_DEFAULT);

  /**
   * Whether importing a clip may call the AI transcript API (Groq Whisper +
   * Gemini) on its own. `false` (the default) means the transcript is only
   * produced when the user asks for it in the editor — a plain cut project
   * never spends an API call.
   */
  autoTranscribe = $state(false);

  /** `5` -> `"5"`, `0.5` -> `"0.5"` — titles and the transport icon. */
  get seekStepLabel(): string {
    return Number.isInteger(this.seekStepSec)
      ? String(this.seekStepSec)
      : this.seekStepSec.toFixed(1);
  }

  /** True when the bin should keep records forever. */
  get trashNever(): boolean {
    return this.trashRetentionDays <= 0;
  }

  /** Unix seconds after which a row deleted at `deletedAt` expires. */
  expiryFor(deletedAt: number): number {
    if (this.trashNever) return Number.POSITIVE_INFINITY;
    return deletedAt + this.trashRetentionDays * 86_400;
  }

  /** Days left before `deletedAt` expires; `Infinity` when never. */
  daysLeft(deletedAt: number, now = Math.floor(Date.now() / 1000)): number {
    if (this.trashNever) return Number.POSITIVE_INFINITY;
    const left = Math.ceil((this.expiryFor(deletedAt) - now) / 86_400);
    return Math.max(0, left);
  }

  setTrashRetentionDays(days: number): void {
    this.trashRetentionDays = coerceDays(days);
    this.persist();
  }

  resetTrashRetention(): void {
    this.setTrashRetentionDays(TRASH_DAYS_DEFAULT);
  }

  /** Set the transport skip step; out-of-range values are clamped, not rejected. */
  setSeekStep(sec: number): void {
    this.seekStepSec = coerceStep(sec);
    this.persist();
  }

  resetSeekStep(): void {
    this.setSeekStep(SEEK_STEP_DEFAULT);
  }

  /** Turn the on-import API call on or off. */
  setAutoTranscribe(on: boolean): void {
    this.autoTranscribe = on;
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(TRASH_DAYS_KEY, String(this.trashRetentionDays));
      localStorage.setItem(SEEK_STEP_KEY, String(this.seekStepSec));
      localStorage.setItem(AUTO_TRANSCRIBE_KEY, this.autoTranscribe ? '1' : '0');
    } catch {
      /* private mode */
    }
  }

  constructor() {
    try {
      const raw = localStorage.getItem(TRASH_DAYS_KEY);
      if (raw !== null) this.trashRetentionDays = coerceDays(raw);
      const step = localStorage.getItem(SEEK_STEP_KEY);
      if (step !== null) this.seekStepSec = coerceStep(step);
      const auto = localStorage.getItem(AUTO_TRANSCRIBE_KEY);
      // Absent = off: asking before an API call is the safe default.
      this.autoTranscribe = auto === '1';
    } catch {
      /* private mode */
    }
  }
}

export const settings = new SettingsStore();
