import type { TranscriptLine } from './types';

/**
 * Word-level cuts: turn a text selection inside one transcript line into the
 * timed parts the editor turns into rows.
 *
 * Why this lives here and not in the component: the mapping between a browser
 * selection (character offsets) and the clock (seconds) is the risky part. It
 * is pure, so `node --test` can prove the arithmetic without a DOM.
 *
 * Two sources of truth, in this order:
 *   1. `line.words` — the engine heard the words and stamped each one. A cut
 *      then lands on the exact millisecond the word was spoken.
 *   2. No word timings (a plain SRT/VTT import, a pasted paragraph): the time
 *      is spread over the line by character count. That is a guess, so the
 *      parts carry `approx` and the UI says so before the user commits.
 *
 * A selection only ever cuts **whole words**: dragging halfway through a word
 * expands to the word it touched. Half a syllable is not an edit anybody can
 * hear.
 */

/** One token of the line's text, with the clock range it covers. */
export interface WordToken {
  /** Exactly as it appears in `line.text` (punctuation stays attached). */
  text: string;
  /** Character offsets in `line.text`, half-open: `[from, to)`. */
  from: number;
  to: number;
  startSec: number;
  endSec: number;
  /** Index of the paired entry in `line.words`, or null without timings. */
  wordFrom: number | null;
  wordTo: number | null;
  /** True when `startSec`/`endSec` were spread by character count. */
  approx: boolean;
}

/** One row the store will create out of a split line. */
export interface WordCutPart {
  text: string;
  fromSec: number;
  toSec: number;
  /** Word timings for this part, when the line had them. */
  words?: Array<{ word: string; start: number; end: number }>;
}

export interface WordCutPlan {
  /** True when any time came from the character-count fallback. */
  approx: boolean;
  /**
   * True once `snapPlanToAudio` moved a boundary onto a real pause in the
   * waveform. The toolbar uses it to say *why* the milliseconds can be
   * trusted, instead of showing an "approx" badge for every line that lacks
   * word timings.
   */
  snapped: boolean;
  /** The selection covered every word: this is a whole-line cut. */
  whole: boolean;
  /** Clock range of the removed words. */
  fromSec: number;
  toSec: number;
  /** Kept words before the selection, if any. */
  prefix: WordCutPart | null;
  /** The words the user asked to remove. */
  cut: WordCutPart;
  /** Kept words after the selection, if any. */
  suffix: WordCutPart | null;
}

/**
 * Compare words the way a listener would: case and punctuation do not count.
 *
 * Combining marks stay. Devanagari matras, the virama and the anusvara are
 * `\p{M}`, not `\p{L}`: dropping them made "कल" and "काल" the same word (both
 * reduced to "कल"), so a look-ahead could pair a token with the wrong take.
 * NFC first so the same word typed two ways compares equal.
 */
function normalize(word: string): string {
  return word
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

/**
 * Tokenise `text` and attach a clock range to every token.
 *
 * With `words`, tokens are paired in order — Whisper's `words[]` and the text
 * are usually the same list — and a small look-ahead absorbs the punctuation
 * or spacing differences between a vendor's text and its word array. Without
 * `words`, the line's duration is shared out by token length.
 */
export function tokenizeLine(
  text: string,
  words: TranscriptLine['words'],
  lineStart: number,
  lineEnd: number
): WordToken[] {
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({
    text: m[0],
    from: m.index ?? 0,
    to: (m.index ?? 0) + m[0].length
  }));
  if (!tokens.length) return [];

  if (words?.length) {
    let cursor = 0;
    return tokens.map((token) => {
      const wanted = normalize(token.text);
      let hit = -1;
      // Look ahead a little: a vendor may merge or split a compound word.
      for (let i = cursor; i < Math.min(words.length, cursor + 4); i++) {
        const got = normalize(words[i].word);
        if (!got) continue;
        if (
          wanted === got ||
          (wanted.length >= 3 && wanted.startsWith(got)) ||
          (got.length >= 3 && got.startsWith(wanted))
        ) {
          hit = i;
          break;
        }
      }
      // No match: stay monotonic rather than jump backwards in the clock.
      if (hit < 0) hit = Math.min(cursor, words.length - 1);
      cursor = Math.max(cursor, hit + 1);
      const word = words[hit];
      return {
        ...token,
        startSec: word.start,
        endSec: word.end,
        wordFrom: hit,
        wordTo: hit,
        approx: false
      };
    });
  }

  const span = Math.max(0, lineEnd - lineStart);
  const total = tokens.reduce((n, t) => n + Math.max(1, t.text.length), 0);
  let walked = 0;
  return tokens.map((token, i) => {
    const weight = Math.max(1, token.text.length);
    const startSec = lineStart + span * (walked / total);
    walked += weight;
    const endSec = i === tokens.length - 1 ? lineEnd : lineStart + span * (walked / total);
    return {
      ...token,
      startSec,
      endSec,
      wordFrom: null,
      wordTo: null,
      approx: true
    };
  });
}

/**
 * Map a selection of `line.text` onto a keep / cut / keep plan.
 *
 * `selectionFrom`/`selectionTo` are character offsets from the browser's
 * selection inside the line's text node. Returns `null` when nothing word-like
 * was selected — a click, a whitespace drag, or a line with no text.
 */
export function planWordCut(
  line: TranscriptLine,
  selectionFrom: number,
  selectionTo: number
): WordCutPlan | null {
  const text = line.text ?? '';
  if (!text.trim()) return null;

  const lo = Math.max(0, Math.min(text.length, Math.min(selectionFrom, selectionTo)));
  const hi = Math.max(0, Math.min(text.length, Math.max(selectionFrom, selectionTo)));
  if (hi <= lo) return null;

  const tokens = tokenizeLine(text, line.words, line.startSec, line.endSec);
  if (!tokens.length) return null;

  let first = -1;
  let last = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.to > lo && t.from < hi) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;

  const fromSec = Math.max(line.startSec, tokens[first].startSec);
  const toSec = Math.min(line.endSec, tokens[last].endSec);
  if (!(toSec > fromSec)) return null;

  const textOf = (a: number, b: number) =>
    tokens
      .slice(a, b + 1)
      .map((t) => t.text)
      .join(' ');

  const wordsOf = (a: number, b: number): WordCutPart['words'] => {
    const source = line.words;
    if (!source?.length) return undefined;
    const start = tokens[a].wordFrom;
    const end = tokens[b].wordTo;
    if (start === null || end === null) return undefined;
    const part = source
      .slice(start, end + 1)
      .map((w) => ({ word: w.word, start: w.start, end: w.end }));
    return part.length ? part : undefined;
  };

  const whole = first === 0 && last === tokens.length - 1;

  // A part that starts and ends on the same millisecond is not a clip. It
  // happens when the first selected word starts exactly on the line boundary
  // (or the last one ends on it); pushing it would create an empty row and an
  // empty block on the timeline ("clip is too small"), so it is not a part at
  // all.
  const EPS = 1e-3;
  const prefix: WordCutPart | null =
    first > 0
      ? {
          text: textOf(0, first - 1),
          fromSec: line.startSec,
          toSec: fromSec,
          words: wordsOf(0, first - 1)
        }
      : null;
  const suffix: WordCutPart | null =
    last < tokens.length - 1
      ? {
          text: textOf(last + 1, tokens.length - 1),
          fromSec: toSec,
          toSec: line.endSec,
          words: wordsOf(last + 1, tokens.length - 1)
        }
      : null;

  return {
    approx: tokens[first].approx,
    snapped: false,
    whole,
    fromSec,
    toSec,
    prefix: prefix && prefix.toSec - prefix.fromSec > EPS ? prefix : null,
    cut: {
      text: textOf(first, last),
      fromSec,
      toSec,
      words: wordsOf(first, last)
    },
    suffix: suffix && suffix.toSec - suffix.fromSec > EPS ? suffix : null
  };
}
