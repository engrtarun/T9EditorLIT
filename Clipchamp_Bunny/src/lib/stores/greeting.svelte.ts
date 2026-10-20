import { greetingLines } from '../ipc';
import { clampLine, pickLine, type GreetingPair, type Lang } from '../greeting';

/**
 * The dashboard greeting.
 *
 * The rule that keeps this cheap: **one generation is shown once**.
 *
 *   · opening the app shows a random line from the hand-written bank (instant,
 *     no network, and different every time),
 *   · in the background it asks the daemon for a pair; if the answer is quick
 *     and newer than the last one shown, it replaces the bank line before the
 *     user has started reading,
 *   · a slow answer (a real Groq call) is stored and shown on the next open.
 *
 * So the API is hit at most once per daemon TTL, while every launch still has
 * a line the user has not seen before.
 */
const STORAGE_KEY = 't9.greeting';
/** Ask the daemon only when the stored pair is older than this. */
const REFRESH_MS = 10 * 60 * 1000;
/** A reply this fast is shown right away; slower ones wait for the next open. */
const SWAP_GRACE_MS = 1400;

interface Saved {
  lang?: Lang;
  pair?: GreetingPair;
  /** `at` of the pair that was already displayed — never show it twice. */
  adopted?: number;
}

class GreetingStore {
  lang = $state<Lang>('hi');
  text = $state('');

  private started = false;
  private shown = '';
  private openedAt = 0;

  init() {
    if (this.started) return;
    this.started = true;
    this.openedAt = Date.now();

    const saved = this.read();
    this.lang = saved.lang === 'en' ? 'en' : 'hi';

    const pending = this.pendingPair(saved);
    if (pending) {
      this.show(pending[this.lang]);
      this.adopt(saved, pending.at);
    } else {
      this.text = this.next(this.lang);
      if (!saved.pair || Date.now() - saved.pair.at > REFRESH_MS) void this.refresh();
    }
  }

  /** The TD avatar menu calls this. */
  setLang(lang: Lang) {
    this.lang = lang;
    const saved = this.read();
    this.write({ ...saved, lang });

    const pending = this.pendingPair(saved);
    if (pending) {
      this.show(pending[lang]);
      this.adopt(this.read(), pending.at);
      return;
    }
    this.text = this.next(lang);
  }

  /** A pair the user has not seen yet. */
  private pendingPair(saved: Saved): GreetingPair | null {
    const pair = saved.pair;
    if (!pair || !pair.en || !pair.hi) return null;
    if (!pair.at || pair.at <= (saved.adopted ?? 0)) return null;
    return pair;
  }

  private async refresh() {
    const started = Date.now();
    const reply = await greetingLines();
    if (!reply || reply.source !== 'groq') return;

    const pair: GreetingPair = {
      en: clampLine(reply.en),
      hi: clampLine(reply.hi),
      at: Date.parse(reply.generatedAt) || Date.now()
    };
    if (!pair.en || !pair.hi) return;

    const saved = this.read();
    // A reply that is already on screen must not count as "new" next launch.
    if (saved.pair && saved.pair.at === pair.at) return;
    this.write({ ...saved, pair });

    if (Date.now() - started <= SWAP_GRACE_MS && pair.at > (saved.adopted ?? 0)) {
      this.show(pair[this.lang]);
      this.adopt(this.read(), pair.at);
    }
  }

  private adopt(saved: Saved, at: number) {
    this.write({ ...saved, adopted: at });
  }

  private show(line: string) {
    this.text = line;
    this.shown = line;
  }

  private next(lang: Lang): string {
    const line = pickLine(lang, this.shown);
    this.shown = line;
    return line;
  }

  private read(): Saved {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Saved) : {};
    } catch {
      return {};
    }
  }

  private write(saved: Saved) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      /* a full/blocked store must never break the dashboard */
    }
  }
}

export const greeting = new GreetingStore();
