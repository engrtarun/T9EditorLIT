import type { TranscriptLine } from './types';

/**
 * Text-level edit suggestions: the "fumble" and "repeat" halves of the
 * timeline sketch's AI note.
 *
 * `project.suggestSilences()` only hears pauses. A speaker who says *"umm,
 * aaa… matlab"* or records the same sentence twice leaves no silence behind —
 * the audio is continuous, so `silencedetect` sees nothing. That is this
 * module's job: read the transcript, not the waveform, and point at the lines
 * that are a false start or a second take.
 *
 * Pure and rune-free, like `segments.ts`, so `node --test` can pin the
 * thresholds without a browser. Nothing here cuts anything: it returns
 * suggestions, and the store stages them for the user to Apply or reject.
 */

/** Why a line looks wrong. */
export type QualityKind = 'fumble' | 'repeat';

export interface QualitySuggestion {
  lineId: string;
  /** Source seconds — the same shape the green preview paints. */
  startSec: number;
  endSec: number;
  kind: QualityKind;
  /** Short, human reason. Shown in the toast/tooltip, never in the file. */
  reason: string;
}

/**
 * Fillers that never carry meaning on their own. Kept deliberately small:
 * "toh", "matlab" and "yaani" are ordinary Hinglish discourse and cutting a
 * line for them would eat real sentences.
 */
const FILLERS = new Set([
  'um',
  'umm',
  'ummm',
  'uh',
  'uhh',
  'uhhh',
  'aaa',
  'aaaa',
  'hmm',
  'hmmm',
  'mmm',
  'erm',
  'err'
]);

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speechTokens(text: string): string[] {
  const normalized = normalizeSpeech(text);
  return normalized ? normalized.split(' ') : [];
}

/** Token overlap, 0..1. Punctuation and case do not count. */
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union ? shared / union : 0;
}

/** True when `a` is a strict prefix of `b` ("soche" → "soche ki"). */
function isPrefix(a: string[], b: string[]): boolean {
  if (a.length >= b.length) return false;
  return a.every((token, i) => token === b[i]);
}

/** The strong, single-line signals. `null` means "this line looks fine". */
export function fumbleReason(line: TranscriptLine): string | null {
  const tokens = speechTokens(line.text);
  if (!tokens.length) return null;

  if (tokens.every((t) => FILLERS.has(t))) {
    return 'Sirf filler ("umm", "aaa") — bolne se pehle ka jhapka';
  }

  if (FILLERS.has(tokens[0]) && tokens.length <= 4) {
    return `"${tokens[0]}" se shuru hone wala adhoora take`;
  }

  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === tokens[i - 1] && tokens[i].length > 1) {
      return `"${tokens[i]}" turant do baar — stutter`;
    }
  }

  // A take the speaker abandoned mid-word, e.g. "aur phir hum—".
  if (/[\u2014-]$/.test(line.text.trim()) && tokens.length <= 8) {
    return 'Adhoora vakya — line beech me khatam';
  }

  return null;
}

/**
 * Every fumble/repeat line the transcript contains, in timeline order.
 *
 * Two passes, because they answer different questions:
 *
 * 1. **per line** — fillers, stutters, an abandoned take, or a flag the cloud
 *    brain already set (`fumble` / `repeat` on the line);
 * 2. **pairs** — two neighbouring takes of the same sentence. The duplicate
 *    is suggested, not both: when one take is a prefix of the other the
 *    shorter one is the false start; when they are near-identical the
 *    **earlier** one goes, because the speaker usually improves on a retry.
 *
 * Lines the user already cut are ignored — there is nothing left to suggest.
 */
export function detectQualitySuggestions(lines: TranscriptLine[]): QualitySuggestion[] {
  const kept = lines.filter((l) => l.keep !== 'cut');
  const seen = new Set<string>();
  const out: QualitySuggestion[] = [];

  const add = (line: TranscriptLine, kind: QualityKind, reason: string) => {
    if (seen.has(line.id)) return;
    seen.add(line.id);
    out.push({
      lineId: line.id,
      startSec: line.startSec,
      endSec: line.endSec,
      kind,
      reason
    });
  };

  for (const line of kept) {
    if (line.flag === 'fumble' || line.flag === 'repeat') {
      add(
        line,
        line.flag,
        line.flag === 'repeat' ? 'AI ne repeat flag kiya' : 'AI ne fumble flag kiya'
      );
      continue;
    }
    const reason = fumbleReason(line);
    if (reason) add(line, 'fumble', reason);
  }

  for (let i = 1; i < kept.length; i++) {
    const before = kept[i - 1];
    const after = kept[i];
    const a = speechTokens(before.text);
    const b = speechTokens(after.text);
    // Short lines ("haan", "theek hai") repeat legitimately; a retake of a
    // real sentence is at least a few words long on both sides.
    if (a.length < 3 || b.length < 3) continue;

    // A false start is worth cutting even when it is much shorter than the
    // take that completes it ("aaj hum timeline" → "… banayenge").
    if (isPrefix(a, b)) {
      add(before, 'repeat', 'Agli line isi ko poora karti hai — pehla adhoora take');
      continue;
    }
    if (isPrefix(b, a)) {
      add(after, 'repeat', 'Pichhli line ka dohraav');
      continue;
    }

    if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.6) continue;
    if (similarity(a, b) < 0.75) continue;
    add(before, 'repeat', 'Agli line lagbhag same hai — pehla take');
  }

  return out.sort((x, y) => x.startSec - y.startSec);
}
