/**
 * Bracket tags, the frontend half of case 23.
 *
 * The daemon sets `tags` on a line, but old projects and the browser mock have
 * no such field. This module derives the same tags from the text, so the UI
 * renders an icon either way - and it keeps the raw text untouched, because
 * "[Music]" is data, not something to delete.
 */

export type TagKind =
  | 'music'
  | 'applause'
  | 'laughter'
  | 'silence'
  | 'noise'
  | 'inaudible'
  | 'cough'
  | 'sigh'
  | 'beep'
  | 'cheering';

const KNOWN: Record<string, TagKind> = {
  music: 'music',
  '♪': 'music',
  '♫': 'music',
  applause: 'applause',
  clapping: 'applause',
  claps: 'applause',
  laughter: 'laughter',
  laughs: 'laughter',
  laughing: 'laughter',
  silence: 'silence',
  quiet: 'silence',
  'door slams': 'noise',
  noise: 'noise',
  static: 'noise',
  inaudible: 'inaudible',
  unintelligible: 'inaudible',
  cough: 'cough',
  coughs: 'cough',
  sigh: 'sigh',
  sighs: 'sigh',
  beep: 'beep',
  bleep: 'beep',
  cheering: 'cheering',
  crowd: 'cheering',
  intro: 'music',
  outro: 'music'
};

const LOCAL_CUES = ['संगीत', 'ताली', 'हँसी', 'हसी', 'शोर', 'मौन', 'आवाज़', 'आवाज'];

const TAG_RE = /\[([^[\]]{1,60})\]|\(([^()]{1,60})\)|(?:^|\s)(♪{1,5})(?:\s|$)/g;

export function tagsOf(text: string): TagKind[] {
  const out: TagKind[] = [];
  for (const match of text.matchAll(TAG_RE)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    let tag = KNOWN[key];
    if (!tag && LOCAL_CUES.some((c) => key.includes(c))) tag = 'noise';
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export function tagIcon(tag: TagKind | string): string {
  switch (tag) {
    case 'music':
      return '♪';
    case 'applause':
      return '👏';
    case 'laughter':
      return '😄';
    case 'silence':
      return '·';
    case 'inaudible':
      return '?';
    case 'cough':
      return '🤧';
    case 'sigh':
      return '…';
    case 'beep':
      return '▮';
    case 'cheering':
      return '📣';
    default:
      return '🔊';
  }
}

export function tagLabel(tag: TagKind | string): string {
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

/**
 * Replace known tags with icons for a preview. Unknown parentheses are left
 * exactly as they are: "(2024)" is content and must not become a sound effect.
 */
export function renderTaggedText(text: string): string {
  return text
    .replace(/\[([^[\]]{1,60})\]|\(([^()]{1,60})\)/g, (whole, square, round) => {
      const raw = (square ?? round ?? '').trim();
      const key = raw.toLowerCase();
      const tag = KNOWN[key] ?? (LOCAL_CUES.some((c) => key.includes(c)) ? 'noise' : undefined);
      return tag ? tagIcon(tag) : whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
