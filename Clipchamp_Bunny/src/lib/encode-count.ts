/**
 * Encode-count discipline (case 36).
 *
 * Generation loss is additive: every re-encode of a file that has already been
 * re-encoded once makes the banding worse. The app cannot undo an export, but
 * it can count them per source and warn before the third pass. The counter is
 * deliberately local and cheap - it is a warning, not a gate.
 */

const PREFIX = 't9.encodes.';

export interface EncodeState {
  count: number;
  lastUnix: number;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function encodesFor(sourceKey: string): EncodeState {
  const store = storage();
  if (!store || !sourceKey) return { count: 0, lastUnix: 0 };
  try {
    const raw = store.getItem(PREFIX + sourceKey);
    if (!raw) return { count: 0, lastUnix: 0 };
    const parsed = JSON.parse(raw) as Partial<EncodeState>;
    return {
      count: Number.isFinite(parsed.count) ? Math.max(0, Number(parsed.count)) : 0,
      lastUnix: Number.isFinite(parsed.lastUnix) ? Number(parsed.lastUnix) : 0
    };
  } catch {
    return { count: 0, lastUnix: 0 };
  }
}

/** Record one successful export and return the new count. */
export function bumpEncodes(sourceKey: string, now = Date.now()): number {
  const store = storage();
  const next = encodesFor(sourceKey).count + 1;
  if (!store || !sourceKey) return next;
  try {
    store.setItem(PREFIX + sourceKey, JSON.stringify({ count: next, lastUnix: now }));
  } catch {
    /* private mode / quota: the count is a nicety, never a blocker */
  }
  return next;
}

/**
 * The warning for a source that has already been through the encoder twice.
 * Empty means "no warning".
 */
export function generationWarning(count: number): string {
  if (count >= 3) {
    return `Ye source ${count} baar export ho chuka hai. Har re-encode banding badhata hai - naya export ek naye master se karo, isi file se nahi.`;
  }
  if (count === 2) {
    return 'Ye doosra export hai. Ek aur re-encode par flat gradients me banding dikh sakti hai.';
  }
  return '';
}
