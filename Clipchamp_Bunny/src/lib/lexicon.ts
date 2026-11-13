/**
 * Creator vocabulary (the frontend half of case 39).
 *
 * The daemon owns the file; this module is the UI's editor and validator. A
 * term survives across videos, which is the whole point: Whisper pays the
 * phonetic-spelling tax on every video, and the lexicon pays it once.
 */

export interface LexiconEntry {
  term: string;
  aliases: string[];
}

export const MAX_TERM_LENGTH = 60;
export const MAX_ALIAS_LENGTH = 80;
export const MAX_ALIASES_PER_TERM = 12;

/** Trim and normalise one entry, or return null when it is not usable. */
export function normalizeEntry(entry: LexiconEntry): LexiconEntry | null {
  const term = entry.term.trim();
  if (!term || term.length > MAX_TERM_LENGTH) return null;
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const raw of entry.aliases) {
    const alias = raw.trim();
    if (!alias || alias.length > MAX_ALIAS_LENGTH) continue;
    if (alias.toLowerCase() === term.toLowerCase()) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
    if (aliases.length >= MAX_ALIASES_PER_TERM) break;
  }
  return { term, aliases };
}

/** Validate a whole vocabulary, dropping duplicates and unusable rows. */
export function normalizeLexicon(entries: LexiconEntry[]): LexiconEntry[] {
  const out: LexiconEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const clean = normalizeEntry(e);
    if (!clean) continue;
    const key = clean.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/** Merge a fetched list with local defaults without losing local additions. */
export function mergeLexicon(base: LexiconEntry[], extra: LexiconEntry[]): LexiconEntry[] {
  return normalizeLexicon([...extra, ...base]);
}

/** "RAG (रैग, राग)" — the row's one-line summary. */
export function entryLabel(entry: LexiconEntry): string {
  return entry.aliases.length ? `${entry.term} (${entry.aliases.join(', ')})` : entry.term;
}

/** What the daemon's deterministic pass would change, for a preview. */
export function countHits(text: string, entries: LexiconEntry[]): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const e of entries) {
    if (e.aliases.some((a) => lower.includes(a.toLowerCase()))) hits.push(e.term);
  }
  return hits;
}
