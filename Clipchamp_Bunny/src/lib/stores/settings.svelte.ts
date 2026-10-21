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

/** The window the user asked for: a binned project is recoverable for 12 days. */
export const TRASH_DAYS_DEFAULT = 12;

/** Hard ceiling — a retention window of ten years is effectively "never". */
const TRASH_DAYS_MAX = 3650;

/** Coerce anything localStorage hands back into a usable retention. */
function coerceDays(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 0) return TRASH_DAYS_DEFAULT;
  return Math.min(n, TRASH_DAYS_MAX);
}

class SettingsStore {
  /** Days a binned project stays recoverable. `0` = never auto-delete. */
  trashRetentionDays = $state(TRASH_DAYS_DEFAULT);

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

  private persist(): void {
    try {
      localStorage.setItem(TRASH_DAYS_KEY, String(this.trashRetentionDays));
    } catch {
      /* private mode */
    }
  }

  constructor() {
    try {
      const raw = localStorage.getItem(TRASH_DAYS_KEY);
      if (raw !== null) this.trashRetentionDays = coerceDays(raw);
    } catch {
      /* private mode */
    }
  }
}

export const settings = new SettingsStore();
