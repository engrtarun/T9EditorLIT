import type { TranscriptLine } from './types';
import type { SilenceRange } from './types';
/**
 * The video's shape: intro, teaching, demo, story, outro.
 *
 * Case 40's finding was that a flat transcript hides the shape, and a flat
 * auto-cut then deletes the two parts that earn the creator money - the hook
 * at the start and the call to action at the end. Everything here is derived
 * from data that already exists: segment times, segment lengths, speech
 * density and a small vocabulary of CTA words. No extra API call.
 */

export type ShapeKind = 'intro' | 'teach' | 'demo' | 'story' | 'outro' | 'dead' | 'unknown';

export interface ShapeSegment {
  kind: ShapeKind;
  start: number;
  end: number;
  /** 0..1: how much of the window had speech. */
  density: number;
  /** Words per minute inside the window. */
  pace: number;
  label: string;
}

export interface ShapeOptions {
  /** Window width. Short videos get a smaller window so the shape is visible. */
  windowSecs?: number;
  /** A window below this density is a demo/typing/dead zone. */
  deadDensity?: number;
}

export const SHAPE_LABEL: Record<ShapeKind, string> = {
  intro: 'Intro / hook',
  teach: 'Teaching',
  demo: 'Demo / dead air',
  story: 'Story',
  outro: 'Outro / CTA',
  dead: 'Dead air',
  unknown: 'Mixed'
};

export const SHAPE_CLASS: Record<ShapeKind, string> = {
  intro: 'bg-nc-brand/70',
  teach: 'bg-nc-teal/60',
  demo: 'bg-nc-gold/60',
  story: 'bg-purple-400/60',
  outro: 'bg-nc-red/60',
  dead: 'bg-nc-mut-2/40',
  unknown: 'bg-nc-line'
};

/**
 * Words that mean "this is the close" in Hinglish/Devanagari.
 *
 * Kept as a read-only signal: a match makes a keep-zone, it never changes the
 * text or forces a cut. "subscribe" in the middle of a sentence is still a
 * keep-zone because cutting a creator's own CTA is the expensive mistake.
 */
const CTA_WORDS = [
  'subscribe',
  'subscriber',
  'comment',
  'comments',
  'like',
  'share',
  'part 2',
  'next video',
  'link in',
  'description',
  'सब्सक्राइब',
  'कमेंट',
  'कमेंट्स',
  'लाइक',
  'शेयर',
  'पार्ट',
  'अगली वीडियो',
  'लिंक',
  'डिस्क्रिप्शन'
];

export function hasCta(text: string): boolean {
  const lower = text.toLowerCase();
  return CTA_WORDS.some((w) => lower.includes(w));
}

/**
 * Build the shape from transcript timings.
 *
 * The algorithm is a windowed read, not a model: density is speech seconds
 * divided by window length, pace is words per speech-minute. Position decides
 * intro/outro, density decides demo/dead, and segment length distinguishes a
 * story (long unbroken turns) from teaching (short, dense turns).
 */
export function buildShape(
  lines: TranscriptLine[],
  durationSecs: number,
  opts: ShapeOptions = {}
): ShapeSegment[] {
  const usable = lines
    .filter((l) => l.text.trim().length > 0 && l.endSec > l.startSec)
    .toSorted((a, b) => a.startSec - b.startSec);
  if (!usable.length) return [];

  const end = durationSecs > 0 ? durationSecs : usable.at(-1)!.endSec;
  const window = opts.windowSecs ?? clamp(end / 24, 20, 90);
  const deadDensity = opts.deadDensity ?? 0.12;
  const count = Math.max(1, Math.ceil(end / window));

  const windows: ShapeSegment[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * window;
    const stop = Math.min(end, start + window);
    if (stop <= start) break;
    const inside = usable.filter((l) => l.endSec > start && l.startSec < stop);
    const speech = inside.reduce(
      (n, l) => n + Math.min(l.endSec, stop) - Math.max(l.startSec, start),
      0
    );
    const words = inside.reduce((n, l) => n + l.text.trim().split(/\s+/).length, 0);
    const density = clamp(speech / (stop - start), 0, 1);
    const pace = speech > 0 ? Math.round((words / speech) * 60) : 0;
    const avgLine = inside.length ? speech / inside.length : 0;
    const cta = inside.some((l) => hasCta(l.text));

    let kind: ShapeKind = 'unknown';
    const nearStart = start < Math.min(180, end * 0.12);
    const nearEnd = stop > end - Math.min(180, end * 0.18);
    if (nearStart && inside.length) kind = 'intro';
    else if (nearEnd && (cta || inside.some((l) => hasCta(l.text)))) kind = 'outro';
    else if (!inside.length || density < deadDensity) kind = 'demo';
    else if (avgLine >= 7 && density >= 0.45) kind = 'story';
    else if (density >= 0.45 && pace >= 80) kind = 'teach';

    windows.push({ kind, start, end: stop, density, pace, label: SHAPE_LABEL[kind] });
  }

  // A CTA window anywhere in the video is an outro-shaped keep-zone, even in
  // the middle (creators often tease part 2 at minute 20).
  for (const w of windows) {
    if (w.kind !== 'intro') {
      const inside = usable.filter((l) => l.endSec > w.start && l.startSec < w.end);
      if (inside.some((l) => hasCta(l.text))) {
        w.kind = w.kind === 'demo' ? 'outro' : w.kind;
      }
    }
  }

  return coalesce(windows);
}

/** Merge adjacent windows of the same kind so the strip does not flicker. */
function coalesce(windows: ShapeSegment[]): ShapeSegment[] {
  const out: ShapeSegment[] = [];
  for (const w of windows) {
    const prev = out.at(-1);
    if (prev && prev.kind === w.kind) {
      const prevLen = prev.end - prev.start;
      const wLen = w.end - w.start;
      const total = prevLen + wLen;
      prev.density = total > 0 ? (prev.density * prevLen + w.density * wLen) / total : 0;
      prev.pace = total > 0 ? Math.round((prev.pace * prevLen + w.pace * wLen) / total) : 0;
      prev.end = w.end;
    } else {
      out.push({ ...w });
    }
  }
  return out;
}

/**
 * The parts auto-cut must not touch: the intro, the outro and every window
 * that carries a call to action.
 */
export function keepZones(shape: ShapeSegment[]): SilenceRange[] {
  return shape
    .filter((s) => s.kind === 'intro' || s.kind === 'outro')
    .map((s) => ({ start: s.start, end: s.end }));
}

/** A one-line legend for the strip's title. */
export function shapeSummary(shape: ShapeSegment[]): string {
  if (!shape.length) return '';
  const counts = new Map<ShapeKind, number>();
  for (const s of shape) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  return (['intro', 'teach', 'demo', 'story', 'outro'] as ShapeKind[])
    .filter((k) => counts.has(k))
    .map((k) => SHAPE_LABEL[k])
    .join(' → ');
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
