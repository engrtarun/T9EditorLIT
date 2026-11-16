/**
 * The address bar's search engines — Firefox's "Search with" picker.
 *
 * Firefox ships a dozen engines; this browser ships the six a T9 user actually
 * picks, in the order the picker draws them. Each engine is a URL template with
 * one `%s` hole, so a picker click and a bare-word Enter go through the same
 * substitution instead of two code paths.
 *
 * The pick is persisted in localStorage — `toUrl()` reads it on every Enter, so
 * a choice survives restarts and works from the speed dial too.
 */

export interface SearchEngine {
  id: string;
  name: string;
  /** URL template; `%s` is replaced with the encoded query. */
  template: string;
  /** Single letter shown in the picker chip and the address bar. */
  letter: string;
  /** The engine's own accent colour, used for the chip. */
  color: string;
}

/** Brave first: no account, no ad profile on every keystroke (the old default). */
export const SEARCH_ENGINES: ReadonlyArray<SearchEngine> = [
  {
    id: 'brave',
    name: 'Brave Search',
    template: 'https://search.brave.com/search?q=%s',
    letter: 'B',
    color: '#fb542b'
  },
  {
    id: 'google',
    name: 'Google',
    template: 'https://www.google.com/search?q=%s',
    letter: 'G',
    color: '#4285f4'
  },
  {
    id: 'bing',
    name: 'Bing',
    template: 'https://www.bing.com/search?q=%s',
    letter: 'b',
    color: '#008373'
  },
  {
    id: 'ddg',
    name: 'DuckDuckGo',
    template: 'https://duckduckgo.com/?q=%s',
    letter: 'D',
    color: '#de5833'
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    template: 'https://www.perplexity.ai/search?q=%s',
    letter: 'P',
    color: '#20808d'
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    template: 'https://en.wikipedia.org/w/index.php?search=%s',
    letter: 'W',
    color: '#636466'
  }
];

const KEY = 't9.searchengine.v1';

/** The saved engine, or Brave when nothing (valid) is stored. */
export function getSearchEngine(): SearchEngine {
  try {
    const id = localStorage.getItem(KEY);
    const found = SEARCH_ENGINES.find((e) => e.id === id);
    if (found) return found;
  } catch {
    // localStorage can refuse in private mode — the default still stands.
  }
  return SEARCH_ENGINES[0];
}

/** Persist the pick. Unknown ids are ignored so a stale value never wins. */
export function setSearchEngine(id: string): void {
  if (!SEARCH_ENGINES.some((e) => e.id === id)) return;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Persistence is a nicety; the pick still applies for this session? No:
    // with storage blocked the write is lost, but the caller shows the pick
    // and toUrl() falls back to the default — never a crash.
  }
}

/** The engine's search URL for a raw query. */
export function searchUrlFor(query: string, id?: string): string {
  const engine = id
    ? (SEARCH_ENGINES.find((e) => e.id === id) ?? getSearchEngine())
    : getSearchEngine();
  return engine.template.replace('%s', encodeURIComponent(query));
}

/**
 * Mirrors `toUrl`'s "is this a search phrase?" rule, so the picker knows
 * whether selecting an engine should navigate immediately or only set the
 * default: a scheme'd URL is never a search, a phrase with a space always is,
 * and a single dotted token is a host.
 */
export function isSearchQuery(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return false;
  return /\s/.test(t) || !t.includes('.');
}
