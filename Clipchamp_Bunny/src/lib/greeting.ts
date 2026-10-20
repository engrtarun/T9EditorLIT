/**
 * Dashboard greeting: the line that replaces "Good to see you again".
 *
 * Two languages, both written by hand here as a floor. The daemon adds a fresh
 * Groq pair now and then; until it arrives (or if it never does) one of these
 * is shown, so the heading is never empty and never waits on the network.
 *
 * The bank is also what keeps the API honest: opening the app forty times does
 * not mean forty generations. The daemon caches, and this bank rotates.
 */

export type Lang = 'en' | 'hi';

export interface GreetingPair {
  en: string;
  hi: string;
  /** Unix ms when the pair was generated. */
  at: number;
}

/** Matches greetingMaxRunes in the daemon — one line, never a paragraph. */
export const GREETING_MAX = 64;

export const GREETING_BANK: Record<Lang, string[]> = {
  en: [
    "New tab, new cut. Let's make it clean.",
    'One clip at a time. Go.',
    'The timeline is waiting. Chop something.',
    'First cut hits different. Start.',
    'Headphones on, excuses off.',
    'Make the boring parts disappear.',
    'Your next upload starts here.',
    'Small cut now, big flex later.',
    'Rough cut first. Pretty later.',
    'Less scrolling, more trimming.',
    'Deadline mode: on.',
    "Let's ship something today.",
    'One good cut beats ten ideas.',
    'Coffee, timeline, done.'
  ],
  hi: [
    'Naya din, naya cut. Chalo shuru.',
    'Ek clip, ek cut. Simple.',
    'Timeline khaali hai. Kuch kaato.',
    'Pehla cut alag hi feel deta hai.',
    'Headphones lagao, bahane band.',
    'Boring part hatao, magic banao.',
    'Aaj ek video upload kar dete hain.',
    'Chhota cut aaj, bada flex baad me.',
    'Rough cut pehle, polish baad me.',
    'Scroll band, trim shuru.',
    'Deadline mode on hai. Chalo.',
    'Aaj kuch ship karte hain.',
    'Ek achha cut das ideas se better hai.',
    'Chai, timeline, done.'
  ]
};

/**
 * Pick a line that is not the one already on screen.
 *
 * When the pool is a single line (a small bank, or every other line filtered
 * out) the same one comes back rather than an empty string.
 */
export function pickLine(lang: Lang, avoid?: string): string {
  const pool = GREETING_BANK[lang];
  const choices = pool.filter((line) => line !== avoid);
  const list = choices.length > 0 ? choices : pool;
  return list[Math.floor(Math.random() * list.length)] ?? '';
}

/** Collapse whitespace and enforce the UI's length budget (code points). */
export function clampLine(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  if (chars.length <= GREETING_MAX) return clean;
  return chars.slice(0, GREETING_MAX).join('').trim();
}
