/**
 * Import a transcript the user made somewhere else.
 *
 * The editor's own transcript comes from ElevenLabs/Groq via the daemon. A user
 * who does not want to spend the API budget can run the same speech-to-text on
 * elevenlabs.io, download the result (Text, SRT, VTT, JSON, HTML, DOCX, PDF)
 * and bring it here. This module is the part that reads those files:
 *
 *   · **SRT / VTT** carry real timestamps, so every cut is exact.
 *   · **JSON** (ElevenLabs' `words` array, plus the common
 *     `segments` / `utterances` / `sentences` shapes) is grouped into lines and
 *     keeps word-level timings.
 *   · **HTML / Text / DOCX / PDF** often have no timings at all. Their lines are
 *     spread across the media in proportion to how many words they hold, and
 *     the result is labelled **estimated** everywhere it is shown — a guessed
 *     cut is never allowed to look like a measured one.
 *
 * Everything here is pure: no IPC, no store, no DOM. The Rust side only turns a
 * DOCX/PDF into text (see `transcript_import.rs`); the parsing lives here so it
 * is testable with `node --test`.
 */
import type { TranscriptLine } from './types';

/** The shapes this module can read without a desktop. */
export type ImportFormat = 'srt' | 'vtt' | 'json' | 'html' | 'text';

/** A raw line of the import, before it becomes a transcript row. */
export interface ImportCue {
  /** Seconds from the start, or `null` when the source had no timing. */
  startSec: number | null;
  endSec: number | null;
  text: string;
  /** Speaker label from `<v Name>`, a `Speaker 1:` prefix, or JSON metadata. */
  speaker?: string;
  /** Word-level timings, when the source carries them (ElevenLabs JSON). */
  words?: Array<{ word: string; start: number; end: number }>;
}

export interface ImportDoc {
  format: ImportFormat;
  cues: ImportCue[];
  /** True when every usable cue carried a start time. */
  timed: boolean;
  /** Cue count that carried a usable start time. */
  timedCues: number;
  /** Words in the source — the preview's honest size number. */
  words: number;
  /** Why the parser picked this format (shown in the preview). */
  reason: string;
}

export interface BuiltImport {
  lines: TranscriptLine[];
  format: ImportFormat;
  /** "ElevenLabs JSON", "SRT", "Text" — the chip the UI shows. */
  label: string;
  /** True when the rows' timings came from the file. */
  timed: boolean;
  /** True when the rows were spread across the media by word count. */
  estimated: boolean;
  /** Distinct speakers in the import (0 when the source had no labels). */
  speakers: number;
  words: number;
  /** Last timestamp the source provided, in seconds (0 when none). */
  coveredSec: number;
  /**
   * Cues that begin after the media ends and were skipped.
   *
   * The usual cause is importing a file made from a different (longer) cut of
   * the same video. Saying how many rows were dropped is more honest than
   * clamping a dozen lines onto the last frame.
   */
  dropped: number;
}

/** A guard rail so a 40 MB paste cannot freeze the 8 GB box. */
export const MAX_IMPORT_CHARS = 4_000_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•'
};

/** `&amp;`, `&#233;`, `&#x2014;` — the entities web exports actually contain. */
function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** The whitespace a copy from a web page / PDF actually contains. */
function cleanText(input: string): string {
  return decodeEntities(input)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Parse `01:02:03,456`, `02:03.456` or `83` into seconds. */
export function parseTimeToken(raw: string): number | null {
  const token = raw.trim().replace(',', '.');
  const m = token.match(/(\d{1,3}(?::\d{2}){0,2})(?:\.(\d{1,3}))?/);
  if (!m) return null;
  const parts = m[1].split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  if (m[2]) seconds += Number.parseInt(m[2].padEnd(3, '0'), 10) / 1000;
  return seconds;
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** A timestamp line of SRT/VTT: `00:01:02,500 --> 00:01:05.000`. */
function isTimingLine(line: string): boolean {
  const arrow = line.indexOf('-->');
  if (arrow < 0) return false;
  return parseTimeToken(line.slice(0, arrow)) !== null;
}

function timingPair(line: string): { start: number; end: number } | null {
  const arrow = line.indexOf('-->');
  if (arrow < 0) return null;
  const start = parseTimeToken(line.slice(0, arrow));
  const end = parseTimeToken(line.slice(arrow + 3));
  if (start === null) return null;
  return { start, end: end ?? start };
}

/** `<v Ravi>Namaste</v>`, `<00:00:01.000>`, `<c.yellow>` → plain words. */
function stripCueTags(input: string): string {
  return cleanText(
    input
      .replace(/<v[\s.][^>]*>/gi, '')
      .replace(/<\/v>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
  );
}

function speakerOf(input: string): string | undefined {
  const voice = input.match(/<v[\s.]([^>]+)>/i);
  if (voice) return cleanText(voice[1]);
  return undefined;
}

/* --------------------------------------------------------------------- SRT */

function parseSrt(input: string): ImportCue[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const cues: ImportCue[] = [];
  let current: { start: number; end: number; text: string[]; speaker?: string } | null = null;

  const flush = () => {
    if (!current) return;
    const text = stripCueTags(current.text.join(' '));
    if (text) {
      cues.push({
        startSec: current.start,
        endSec: current.end,
        text,
        ...(current.speaker ? { speaker: current.speaker } : {})
      });
    }
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (isTimingLine(line)) {
      flush();
      const pair = timingPair(line);
      if (pair) current = { ...pair, text: [] };
      continue;
    }
    if (!current) continue; // the cue number / header before the timestamp
    if (!line.trim()) {
      flush();
      continue;
    }
    current.speaker ??= speakerOf(line);
    current.text.push(line.trim());
  }
  flush();
  return cues;
}

/* --------------------------------------------------------------------- VTT */

function parseVtt(input: string): ImportCue[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const cues: ImportCue[] = [];
  let skipBlock = false;
  let current: { start: number; end: number; text: string[]; speaker?: string } | null = null;

  const flush = () => {
    if (!current) return;
    const text = stripCueTags(current.text.join(' '));
    if (text) {
      cues.push({
        startSec: current.start,
        endSec: current.end,
        text,
        ...(current.speaker ? { speaker: current.speaker } : {})
      });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0 && /^WEBVTT/i.test(line)) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(line)) {
      skipBlock = true;
      continue;
    }
    if (!line) {
      flush();
      skipBlock = false;
      continue;
    }
    if (skipBlock) continue;
    if (isTimingLine(line)) {
      flush();
      const pair = timingPair(line);
      // A cue identifier line can sit right above the timestamp.
      if (pair) current = { ...pair, text: [] };
      continue;
    }
    if (!current) continue;
    current.speaker ??= speakerOf(line);
    current.text.push(line);
  }
  flush();
  return cues;
}

/* -------------------------------------------------------------------- JSON */

interface LooseObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is LooseObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberAt(obj: LooseObject, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function stringAt(obj: LooseObject, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

const START_KEYS = ['start', 'startSec', 'start_secs', 'startTime', 'start_time', 'from', 'begin'];
const END_KEYS = ['end', 'endSec', 'end_secs', 'endTime', 'end_time', 'to', 'stop'];
const TEXT_KEYS = ['text', 'content', 'transcript', 'caption', 'sentence', 'value', 'line'];

/**
 * Read a cue's own `words` array.
 *
 * ElevenLabs' JSON puts the timings **inside each segment**
 * (`segments[].words[].start_time`), not at the document root. The old parser
 * only looked for a top-level `words` array and therefore threw those timings
 * away: every line arrived without `line.words`, so every word cut fell back
 * to a character-count guess. That is exactly the "selected word, wrong audio"
 * bug — the guess can land a syllable early or late.
 *
 * Spacing/silence entries carry no letters and are dropped; the rest keep
 * their own start/end, so the cut is as exact as the file's own stamps.
 */
function wordsFromObject(obj: LooseObject): ImportCue['words'] | undefined {
  if (!Array.isArray(obj.words)) return undefined;
  const out: Array<{ word: string; start: number; end: number }> = [];
  for (const entry of obj.words) {
    if (!isObject(entry)) continue;
    const type = stringAt(entry, ['type']).toLowerCase();
    if (type === 'spacing' || type === 'silence') continue;
    const word = stringAt(entry, ['word', 'text', 'content', 'value']);
    if (!word.trim()) continue;
    const start = numberAt(entry, START_KEYS);
    const end = numberAt(entry, END_KEYS);
    if (start === null || end === null || end <= start) continue;
    out.push({ word: word.trim(), start, end });
  }
  return out.length ? out : undefined;
}

function cueFromObject(obj: LooseObject): ImportCue | null {
  const text = stringAt(obj, TEXT_KEYS);
  if (!text && !Array.isArray(obj.words)) return null;
  let start = numberAt(obj, START_KEYS);
  let end = numberAt(obj, END_KEYS);
  // YouTube's timedtext shape: `tStartMs` / `dDurationMs`.
  const msStart = numberAt(obj, ['tStartMs', 'startMs', 'start_ms']);
  const msDuration = numberAt(obj, ['dDurationMs', 'durationMs', 'duration_ms']);
  if (start === null && msStart !== null) start = msStart / 1000;
  if (end === null && msDuration !== null) end = (start ?? 0) + msDuration / 1000;
  // A few tools nest the cue's words but no top-level text.
  if (!text && Array.isArray(obj.words)) {
    const joined = (obj.words as unknown[])
      .map((w) => (isObject(w) ? stringAt(w, TEXT_KEYS) : ''))
      .join(' ');
    if (!joined.trim()) return null;
    return {
      startSec: start,
      endSec: end,
      text: cleanText(joined),
      words: wordsFromObject(obj),
      ...speakerFromObject(obj)
    };
  }
  return {
    startSec: start,
    endSec: end,
    text: cleanText(text),
    words: wordsFromObject(obj),
    ...speakerFromObject(obj)
  };
}

function speakerFromObject(obj: LooseObject): { speaker?: string } {
  const raw =
    stringAt(obj, ['speaker', 'speakerLabel', 'speaker_label']) ||
    (typeof obj.speaker_id === 'string' ? obj.speaker_id : '');
  if (!raw) return {};
  const match = raw.match(/(\d+)/);
  return { speaker: match ? `Speaker ${Number.parseInt(match[1], 10) + 1}` : cleanText(raw) };
}

/** The arrays that carry cues, best first. */
const CUE_KEYS = [
  'segments',
  'utterances',
  'sentences',
  'transcripts',
  'cues',
  'captions',
  'lines'
];

function findCueArray(value: unknown, depth = 0): unknown[] | null {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    const looksLikeCues = value.some(
      (item) => isObject(item) && (stringAt(item, TEXT_KEYS) || Array.isArray(item.words))
    );
    return looksLikeCues ? value : null;
  }
  if (!isObject(value)) return null;
  for (const key of CUE_KEYS) {
    const child = value[key];
    if (Array.isArray(child) && child.length) return child;
  }
  for (const child of Object.values(value)) {
    const found = findCueArray(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findWordArray(value: unknown, depth = 0): LooseObject[] | null {
  if (depth > 5 || !isObject(value)) return null;
  const words = value.words;
  if (Array.isArray(words) && words.length) {
    const first = words[0];
    // ElevenLabs calls the fields `start_time` / `end_time`, AssemblyAI uses
    // `start` / `end`, and the app's own wire format uses `start_secs`. All
    // three are word arrays; only looking for the last one discarded the
    // timings of the most common export.
    if (
      isObject(first) &&
      numberAt(first, ['start', 'start_time', 'startTime', 'start_secs', 'startSec']) !== null &&
      numberAt(first, ['end', 'end_time', 'endTime', 'end_secs', 'endSec']) !== null
    ) {
      return words.filter(isObject);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    // Never descend into a cue array: its `words` belong to one segment, and
    // treating the first one as the whole document would drop every other
    // line. Per-cue words are read by `cueFromObject` instead.
    if (CUE_KEYS.includes(key)) continue;
    const found = findWordArray(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** ElevenLabs returns one entry per word (plus punctuation/spacing entries). */
function cuesFromWords(words: LooseObject[]): ImportCue[] {
  const cues: ImportCue[] = [];
  let current: {
    start: number;
    end: number;
    text: string;
    words: Array<{ word: string; start: number; end: number }>;
    speaker?: string;
  } | null = null;

  const flush = () => {
    if (!current) return;
    const text = cleanText(current.text);
    if (text) {
      cues.push({
        startSec: current.start,
        endSec: current.end,
        text,
        words: current.words,
        ...(current.speaker ? { speaker: current.speaker } : {})
      });
    }
    current = null;
  };

  for (const entry of words) {
    const type = stringAt(entry, ['type']);
    const raw = stringAt(entry, TEXT_KEYS) || stringAt(entry, ['word']);
    if (!raw.trim()) continue;
    if (type === 'spacing' || type === 'silence') continue;
    const start = numberAt(entry, START_KEYS) ?? 0;
    const end = numberAt(entry, END_KEYS) ?? start;
    const speaker = speakerFromObject(entry).speaker;
    const word = raw.trim();
    const gap = current ? start - current.end : 0;
    const sentenceEnd = !!current && /[.!?…]["')\]]?$/.test(current.text.trim());
    const tooLong =
      !!current &&
      (current.words.length >= 18 ||
        current.text.length >= 120 ||
        end - current.start > 9 ||
        (sentenceEnd && current.words.length >= 5));

    if (
      current &&
      (gap > 0.85 || tooLong || (speaker && current.speaker && speaker !== current.speaker))
    ) {
      flush();
    }
    if (!current) {
      current = { start, end, text: word, words: [{ word, start, end }], speaker };
      continue;
    }
    // `"Hello," + "world"` must read as `Hello, world`, not `Hello , world`.
    const glued = /^[,.;:!?%)\]]/.test(word) || /[(\[]$/.test(current.text);
    current.text += glued ? word : ` ${word}`;
    current.end = Math.max(current.end, end);
    current.words.push({ word, start, end });
    current.speaker ??= speaker;
  }
  flush();
  return cues;
}

function fromJson(value: unknown): ImportCue[] {
  if (Array.isArray(value)) {
    const cues = value
      .map((item) => {
        if (typeof item === 'string') {
          const text = cleanText(item);
          return text ? { startSec: null, endSec: null, text } : null;
        }
        return isObject(item) ? cueFromObject(item) : null;
      })
      .filter((cue): cue is ImportCue => !!cue && !!cue.text);
    if (cues.length) return cues;
  }
  if (isObject(value)) {
    const words = findWordArray(value);
    // `words` is the most precise shape; `text` alone is the fallback.
    if (words?.length) return cuesFromWords(words);
    const array = findCueArray(value);
    if (array) {
      const cues = array
        .map((item) => (isObject(item) ? cueFromObject(item) : null))
        .filter((cue): cue is ImportCue => !!cue && !!cue.text);
      if (cues.length) return cues;
    }
    const single = cueFromObject(value);
    if (single?.text) {
      const lines = single.text
        .split(/\n+/)
        .map((t) => cleanText(t))
        .filter(Boolean);
      if (lines.length > 1) {
        return lines.map((text) => ({ startSec: null, endSec: null, text }));
      }
      return [single];
    }
  }
  return [];
}

/* -------------------------------------------------------------------- HTML */

function htmlToText(input: string): string {
  return input
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r\n?/g, '\n');
}

/* -------------------------------------------------------------------- text */

const LINE_TIME_RE = /^\[?\(?((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\)?\]?\s*(?:[-–—•|]\s*)?/;

function cueFromTimedLines(lines: string[]): ImportCue[] {
  const cues: ImportCue[] = [];
  for (const line of lines) {
    const match = line.match(LINE_TIME_RE);
    if (!match) continue;
    const start = parseTimeToken(match[1]);
    if (start === null) continue;
    const text = cleanText(line.slice(match[0].length));
    if (!text) continue;
    cues.push({ startSec: start, endSec: null, text });
  }
  for (let i = 0; i < cues.length - 1; i++) cues[i].endSec = cues[i + 1].startSec;
  return cues;
}

/**
 * Split a paragraph that has no timings into readable lines.
 *
 * A 900-word paragraph is one row the user cannot cut; sentences are the
 * smallest unit that still reads like speech, so they are packed back together
 * up to a comfortable row length.
 */
function splitParagraphs(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => cleanText(p.replace(/\n+/g, ' ')))
    .filter(Boolean);
  const rows: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= 180 && wordCount(paragraph) <= 32) {
      rows.push(paragraph);
      continue;
    }
    // Sentence split that keeps the punctuation. `Intl.Segmenter` is not
    // available in every webview build, so the regex is the portable path.
    const sentences = paragraph.match(/[^.!?…]+[.!?…]+["')\]]?|[^.!?…]+$/g) ?? [paragraph];
    let rolling = '';
    for (const raw of sentences) {
      const sentence = cleanText(raw);
      if (!sentence) continue;
      if (!rolling) {
        rolling = sentence;
      } else if (
        (rolling + ' ' + sentence).length <= 180 &&
        wordCount(rolling + ' ' + sentence) <= 32
      ) {
        rolling += ' ' + sentence;
      } else {
        rows.push(rolling);
        rolling = sentence;
      }
    }
    if (rolling) rows.push(rolling);
  }
  return rows;
}

function parsePlainText(input: string): ImportCue[] {
  const lines = input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Timed copy: every other line starts with `[00:12]` or `00:12 -`.
  const timed = lines.filter(
    (l) => LINE_TIME_RE.test(l) && parseTimeToken(l.match(LINE_TIME_RE)![1]) !== null
  );
  if (timed.length >= 2 && timed.length >= lines.length * 0.4) {
    return cueFromTimedLines(lines);
  }

  // One short line per utterance is what every "copy transcript" button
  // produces; keeping those lines is better than re-flowing them into
  // paragraphs and losing the speaker breaks.
  const shortLines =
    lines.length >= 3 && lines.filter((line) => line.length <= 140).length >= lines.length * 0.6;
  const paragraphs = shortLines ? lines : splitParagraphs(input);
  const cues: ImportCue[] = paragraphs.map((raw) => {
    const speaker = raw.match(/^(?:\[?(SPEAKER|Speaker)\s*(\d+)\]?|(SPEAKER\s*\d+))\s*[:：-]\s*/);
    const text = cleanText(speaker ? raw.slice(speaker[0].length) : raw);
    return {
      startSec: null,
      endSec: null,
      text,
      ...(speaker ? { speaker: `Speaker ${speaker[2] ?? speaker[3].replace(/\D/g, '')}` } : {})
    };
  });
  return cues.filter((c) => c.text);
}

/* ----------------------------------------------------------- format detect */

function detectFormat(text: string, fileName = ''): { format: ImportFormat; reason: string } {
  const head = text.replace(/^\uFEFF/, '').trimStart();
  if (/^WEBVTT\b/i.test(head)) return { format: 'vtt', reason: 'WEBVTT header' };
  if (
    /-->/.test(head.slice(0, 4000)) &&
    isTimingLine(head.split(/\r?\n/).find((l) => l.includes('-->')) ?? '')
  ) {
    return {
      format: 'srt',
      reason: /^\d+\s*$/m.test(head) ? 'SRT cue numbers' : 'arrow timestamps'
    };
  }
  if (head.startsWith('{') || head.startsWith('[')) {
    try {
      JSON.parse(text);
      return { format: 'json', reason: 'valid JSON' };
    } catch {
      /* a text file may still begin with a bracket */
    }
  }
  if (/^<(!doctype|html|head|body|div|p|table|main|article)\b/i.test(head)) {
    return { format: 'html', reason: 'HTML tags' };
  }
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'srt') return { format: 'srt', reason: '.srt file' };
  if (ext === 'vtt') return { format: 'vtt', reason: '.vtt file' };
  if (ext === 'json') return { format: 'json', reason: '.json file' };
  if (ext === 'html' || ext === 'htm') return { format: 'html', reason: '.html file' };
  return { format: 'text', reason: 'plain text' };
}

/* ------------------------------------------------------------------ public */

export interface ParseOptions {
  /** The media's length — needed to tell seconds from milliseconds. */
  durationSecs?: number;
  /** The name of the file the text came from, when it came from a file. */
  fileName?: string;
}

/** Auto-detect and parse. Never throws; an empty document means "no cues". */
export function parseTranscript(text: string, opts: ParseOptions = {}): ImportDoc {
  const clean = text.replace(/^\uFEFF/, '');
  if (!clean.trim()) {
    return { format: 'text', cues: [], timed: false, timedCues: 0, words: 0, reason: 'empty' };
  }
  const { format, reason } = detectFormat(clean, opts.fileName);
  let cues: ImportCue[] = [];
  let jsonParsed = false;
  try {
    if (format === 'srt') cues = parseSrt(clean);
    else if (format === 'vtt') cues = parseVtt(clean);
    else if (format === 'json') {
      const value = JSON.parse(clean);
      jsonParsed = true;
      cues = fromJson(value);
    } else if (format === 'html') cues = parsePlainText(htmlToText(clean));
    else cues = parsePlainText(clean);
  } catch {
    cues = [];
  }
  if (!cues.length && format !== 'text' && !jsonParsed) {
    // An SRT/HTML file with an exotic shape still has words in it; falling
    // back to plain text is better than "0 lines" when the user can see text.
    // Valid JSON is the exception: its braces are not human text, and a shape
    // we do not recognise should be reported as "no transcript found".
    cues = parsePlainText(format === 'html' ? htmlToText(clean) : clean);
  }
  cues = normalizeTimes(cues, opts.durationSecs ?? 0);
  const words = cues.reduce((n, cue) => n + wordCount(cue.text), 0);
  const timedCues = cues.filter((cue) => cue.startSec !== null).length;
  return {
    format,
    cues,
    timed: cues.length > 0 && timedCues === cues.length,
    timedCues,
    words,
    reason
  };
}

/** ElevenLabs is seconds; AssemblyAI/YouTube are milliseconds. */
function normalizeTimes(cues: ImportCue[], durationSecs: number): ImportCue[] {
  if (!durationSecs) return cues;
  let max = 0;
  for (const cue of cues) {
    max = Math.max(max, cue.startSec ?? 0, cue.endSec ?? 0);
  }
  const looksLikeMs = max > durationSecs * 2.5 && max / 1000 <= durationSecs * 1.5;
  if (!looksLikeMs) return cues;
  return cues.map((cue) => ({
    ...cue,
    startSec: cue.startSec === null ? null : cue.startSec / 1000,
    endSec: cue.endSec === null ? null : cue.endSec / 1000,
    words: cue.words?.map((w) => ({ ...w, start: w.start / 1000, end: w.end / 1000 }))
  }));
}

function clampSec(value: number, durationSecs: number): number {
  if (!Number.isFinite(value)) return 0;
  const top = durationSecs > 0 ? Math.max(0, durationSecs - 0.03) : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(0, value), top);
}

/**
 * Turn parsed cues into transcript rows.
 *
 * Timed cues keep their own timestamps and are made monotonic (a video cannot
 * have two lines at 00:12 if the second starts at 00:09). Untimed cues are
 * spread over the media by word count, which is the only honest thing to do
 * without an aligner — and the caller is told it happened via `estimated`.
 */
export function buildTranscriptLines(
  doc: ImportDoc,
  durationSecs: number,
  idPrefix = `imp-${Date.now().toString(36)}`
): BuiltImport {
  const duration = Math.max(0, durationSecs);
  const all = doc.cues.filter((cue) => cue.text.trim());
  // A transcript from a longer cut of the same video is a real case: its tail
  // has nowhere to land, so it is counted and dropped instead of smeared over
  // the final frame.
  const cues = duration > 0 ? all.filter((cue) => (cue.startSec ?? 0) < duration) : all;
  const dropped = all.length - cues.length;
  const speakers = new Set(cues.map((cue) => cue.speaker).filter(Boolean));
  const prefixSpeaker = speakers.size > 1;
  const lines: TranscriptLine[] = [];

  if (doc.timed) {
    let cursor = 0;
    cues.forEach((cue, index) => {
      const start = clampSec(Math.max(cursor, cue.startSec ?? 0), duration);
      const nextStart = cues[index + 1]?.startSec;
      const estimate = Math.max(0.8, wordCount(cue.text) / 2.8);
      let end = cue.endSec ?? nextStart ?? start + estimate;
      end = clampSec(Math.max(end, start + 0.3), duration);
      cursor = end;
      lines.push({
        id: `${idPrefix}-${index + 1}`,
        startSec: start,
        endSec: end,
        text: prefixSpeaker && cue.speaker ? `${cue.speaker}: ${cue.text}` : cue.text,
        flag: 'none',
        keep: 'keep',
        confidence: 1,
        ...(cue.words?.length ? { words: cue.words } : {})
      });
    });
  } else {
    const weights = cues.map((cue) => Math.max(1, wordCount(cue.text)));
    const total = weights.reduce((n, w) => n + w, 0);
    const span = duration > 0 ? duration : total * 0.45; // no media: 2.2 words/s
    let cursor = 0;
    cues.forEach((cue, index) => {
      const isLast = index === cues.length - 1;
      const end = isLast ? span : cursor + (weights[index] / total) * span;
      lines.push({
        id: `${idPrefix}-${index + 1}`,
        startSec: clampSec(cursor, duration || span),
        endSec: clampSec(Math.max(cursor + 0.3, end), duration || span),
        text: prefixSpeaker && cue.speaker ? `${cue.speaker}: ${cue.text}` : cue.text,
        flag: 'none',
        keep: 'keep',
        confidence: 1
      });
      cursor = end;
    });
  }

  const covered = doc.cues.reduce((max, cue) => Math.max(max, cue.endSec ?? cue.startSec ?? 0), 0);
  return {
    lines,
    format: doc.format,
    label: importLabel(doc),
    timed: doc.timed,
    estimated: cues.length > 0 && !doc.timed,
    speakers: speakers.size,
    words: doc.words,
    coveredSec: covered,
    dropped
  };
}

/** One timed word from any import shape, flattened into clock order. */
export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

/**
 * Every word timing the imported document carries.
 *
 * Used to repair projects imported before nested `segments[].words` were read:
 * the rows are still there, and the same JSON file is still on disk, so the
 * exact timings can be re-attached without re-importing (and losing) the cuts.
 */
export function collectImportWords(doc: ImportDoc): TimedWord[] {
  const out: TimedWord[] = [];
  for (const cue of doc.cues) {
    if (!cue.words?.length) continue;
    for (const w of cue.words) {
      if (!w.word.trim() || !(w.end > w.start)) continue;
      out.push({ word: w.word.trim(), start: w.start, end: w.end });
    }
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

/**
 * Lowercase letters/numbers only — the same comparison a listener makes.
 *
 * Combining marks (`\p{M}`) belong to the letter they sit on. Devanagari
 * matras, the virama and the anusvara are marks, not letters: leaving them out
 * split "कुछ" into `["क", "छ"]` and "किए" into `["क", "ए"]`, which made every
 * Hindi token match every other one (and left two real SHORT6 rows unmatched,
 * because their token count could never agree with the file). NFC first so the
 * same word typed two ways compares equal.
 */
function wordKey(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t && /[\p{L}\p{N}]/u.test(t));
}

/**
 * Attach imported word timings to rows that lost them.
 *
 * The rows are matched by **time first** (their own start/end already bracket
 * the words) and the text must agree, so a mis-timed neighbour cannot steal a
 * word. When the row's times drift too far from the file, a sequential token
 * match is tried: the row text is the file's own words in order, so the
 * sequence is unambiguous and a retake is skipped rather than reused.
 *
 * Rows that already carry `words` are never touched. Returns a new array (the
 * store's `$state.raw` sees one assignment) and how many rows were repaired.
 */
export function attachWordsToLines(
  lines: TranscriptLine[],
  words: TimedWord[]
): { lines: TranscriptLine[]; attached: number; wordCount: number } {
  if (!words.length || !lines.length) return { lines, attached: 0, wordCount: 0 };

  const claimed = new Uint8Array(words.length);
  let attached = 0;
  let used = 0;
  let cursor = 0;

  const out = lines.map((line) => {
    if (line.words?.length) {
      // Keep the cursor past the words this row already owns.
      const last = line.words[line.words.length - 1];
      while (cursor < words.length && words[cursor].end <= last.end + 0.001) cursor++;
      return line;
    }
    const want = wordKey(line.text);
    if (!want.length) return line;

    const take = (indexes: number[]): TimedWord[] | null => {
      if (!indexes.length) return null;
      if (indexes.some((i) => claimed[i])) return null;
      const picked = indexes.map((i) => words[i]);
      const got = picked.flatMap((w) => wordKey(w.word));
      if (got.length !== want.length) return null;
      for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) return null;
      return picked;
    };

    // 1 — time window: a row's own bracket is the strongest signal.
    const inWindow: number[] = [];
    for (let i = 0; i < words.length; i++) {
      if (claimed[i]) continue;
      const mid = (words[i].start + words[i].end) / 2;
      if (mid >= line.startSec - 0.2 && mid <= line.endSec + 0.2) inWindow.push(i);
    }
    let picked = take(inWindow);
    let pickedAt: number[] = inWindow;

    // 2 — sequential fallback: find the row's first word at/after the cursor,
    // then require every token to follow in order. This is what skips a retake.
    //
    // Every matched word must also start near the row's own bracket. Without
    // that guard a row whose text covers a *later* repeated take (a split made
    // before word timings existed keeps the whole sentence in both halves)
    // would claim words seconds past its end and leave the row that really
    // owns them with nothing — exactly what happened to SHORT6's "और कुछ…".
    //
    // The check is on the word's **start**, not its midpoint: a row boundary
    // can legitimately fall inside the last word (`cut at 80.02`, the word
    // runs to 80.82), and those words still belong to this row. Half a second
    // is the widest drift such a boundary can have and still be the same
    // words.
    if (!picked) {
      const nearRow = (w: TimedWord) =>
        w.start >= line.startSec - 0.5 && w.start <= line.endSec + 0.5;
      const first = want[0];
      for (let start = cursor; start < words.length && !picked; start++) {
        if (!wordKey(words[start].word).includes(first)) continue;
        const indexes: number[] = [];
        let wi = start;
        let ok = true;
        for (const token of want) {
          let found = -1;
          for (let probe = wi; probe < Math.min(words.length, wi + 4); probe++) {
            if (wordKey(words[probe].word).includes(token)) {
              found = probe;
              break;
            }
          }
          if (found < 0) {
            ok = false;
            break;
          }
          indexes.push(found);
          wi = found + 1;
        }
        if (!ok) continue;
        if (!indexes.every((i) => nearRow(words[i]))) continue;
        const candidate = take(indexes);
        if (candidate) {
          picked = candidate;
          pickedAt = indexes;
        }
      }
    }

    if (!picked) return line;
    for (const i of pickedAt) claimed[i] = 1;
    for (const i of pickedAt) cursor = Math.max(cursor, i + 1);
    attached++;
    used += picked.length;
    return {
      ...line,
      words: picked.map((w) => ({ word: w.word, start: w.start, end: w.end }))
    };
  });

  return { lines: attached ? out : lines, attached, wordCount: used };
}

/** What the modal shows under the textarea. */
export function describeFormat(format: ImportFormat): string {
  switch (format) {
    case 'srt':
      return 'SRT';
    case 'vtt':
      return 'WebVTT';
    case 'json':
      return 'JSON';
    case 'html':
      return 'HTML';
    default:
      return 'Text';
  }
}

/** "ElevenLabs JSON", "SRT", "Text" — the preview's chip. */
export function importLabel(doc: ImportDoc): string {
  const hasWordTimings = doc.cues.some((cue) => !!cue.words?.length);
  return doc.format === 'json' && hasWordTimings ? 'ElevenLabs JSON' : describeFormat(doc.format);
}
