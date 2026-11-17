/**
 * Search engines — two pickers, two groups, two saved defaults.
 *
 * The browser keeps **two independent picks**, because the two boxes answer
 * different questions:
 *
 *  - **Address bar** (`group = 'web'`): the user is going somewhere or wants
 *    links — Brave, Google, Bing, DuckDuckGo, Wikipedia only. Default: Brave.
 *  - **Speed dial** (`group = 'ai'`): a fresh tab is for asking — the free
 *    no-login answer engines (Perplexity, DuckDuckGo AI, Microsoft Copilot,
 *    Andi, Komo). Default: Perplexity.
 *
 * Each group persists under its own localStorage key, so picking a web
 * engine in the URL bar never steals the dial's AI default (the pre-split
 * single key is still read once, to migrate an AI pick made before the
 * split). This file is a `.svelte.ts` so the active engines live in module
 * `$state`: both chips repaint the instant either picker changes one.
 *
 * Every engine carries its own homepage (`site`) because the pickers draw
 * the **real brand logo**, fetched through `SiteIcon` — never a letter tile.
 * The fallback chain (daemon proxy → the site → Google's favicon CDN) covers
 * the hosts that 404 their own `/favicon.ico`.
 */

export type EngineGroup = 'ai' | 'web';

export interface SearchEngine {
  id: string;
  name: string;
  /** URL template; `%s` is replaced with the encoded query. */
  template: string;
  /** The engine's homepage — where its real favicon is fetched from. */
  site: string;
  /** Which picker group the row belongs to. */
  group: EngineGroup;
}

export const SEARCH_ENGINES: ReadonlyArray<SearchEngine> = [
  // --- the dial's group: free, no login, answers the query itself ---
  {
    id: 'perplexity',
    name: 'Perplexity',
    template: 'https://www.perplexity.ai/search?q=%s',
    site: 'https://www.perplexity.ai',
    group: 'ai'
  },
  {
    id: 'ddg-ai',
    name: 'DuckDuckGo AI',
    template: 'https://duck.ai/chat?q=%s',
    site: 'https://duck.ai',
    group: 'ai'
  },
  {
    id: 'copilot',
    name: 'Microsoft Copilot',
    template: 'https://copilot.microsoft.com/?q=%s',
    site: 'https://copilot.microsoft.com',
    group: 'ai'
  },
  {
    id: 'andi',
    name: 'Andi',
    template: 'https://andisearch.com/?q=%s',
    site: 'https://andisearch.com',
    group: 'ai'
  },
  {
    id: 'komo',
    name: 'Komo',
    template: 'https://komo.ai/?q=%s',
    site: 'https://komo.ai',
    group: 'ai'
  },
  // --- the address bar's group: the classic index searchers ---
  {
    id: 'brave',
    name: 'Brave Search',
    template: 'https://search.brave.com/search?q=%s',
    site: 'https://search.brave.com',
    group: 'web'
  },
  {
    id: 'google',
    name: 'Google',
    template: 'https://www.google.com/search?q=%s',
    site: 'https://www.google.com',
    group: 'web'
  },
  {
    id: 'bing',
    name: 'Bing',
    template: 'https://www.bing.com/search?q=%s',
    site: 'https://www.bing.com',
    group: 'web'
  },
  {
    id: 'ddg',
    name: 'DuckDuckGo',
    template: 'https://duckduckgo.com/?q=%s',
    site: 'https://duckduckgo.com',
    group: 'web'
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    template: 'https://en.wikipedia.org/w/index.php?search=%s',
    site: 'https://en.wikipedia.org',
    group: 'web'
  }
];

/** One key per group; the legacy key is read once, for migration only. */
const WEB_KEY = 't9.searchengine.v1';
const AI_KEY = 't9.searchengine.ai.v1';

const DEFAULT_ID: Record<EngineGroup, string> = { web: 'brave', ai: 'perplexity' };

function firstOf(group: EngineGroup): SearchEngine {
  // The lists above are ordered defaults-first, so index 0 is the fallback.
  return SEARCH_ENGINES.find((e) => e.id === DEFAULT_ID[group]) ?? SEARCH_ENGINES[0];
}

function load(group: EngineGroup): SearchEngine {
  const key = group === 'web' ? WEB_KEY : AI_KEY;
  try {
    let id = localStorage.getItem(key);
    // Migration: before the split one key held both groups. An AI pick made
    // there belongs to the dial now; seed the dial from it instead of
    // silently dropping the user's choice.
    if (group === 'ai' && !id) {
      const legacy = localStorage.getItem(WEB_KEY);
      if (legacy && SEARCH_ENGINES.some((e) => e.id === legacy && e.group === 'ai')) id = legacy;
    }
    const found = SEARCH_ENGINES.find((e) => e.id === id && e.group === group);
    if (found) return found;
  } catch {
    // localStorage can refuse in private mode — the default still stands.
  }
  return firstOf(group);
}

let currentWeb = $state<SearchEngine>(load('web'));
let currentAi = $state<SearchEngine>(load('ai'));

/** The saved engine for a group; reactive, so chips repaint on a pick. */
export function getSearchEngine(group: EngineGroup): SearchEngine {
  return group === 'ai' ? currentAi : currentWeb;
}

/**
 * Persist a pick under its own group's key. Unknown ids are ignored so a
 * stale value never wins; the id's group decides which of the two picks moves.
 */
export function setSearchEngine(id: string): void {
  const found = SEARCH_ENGINES.find((e) => e.id === id);
  if (!found) return;
  if (found.group === 'ai') {
    currentAi = found;
    try {
      localStorage.setItem(AI_KEY, id);
    } catch {
      // Storage blocked: the pick still applies for this session.
    }
  } else {
    currentWeb = found;
    try {
      localStorage.setItem(WEB_KEY, id);
    } catch {
      // Storage blocked: the pick still applies for this session.
    }
  }
}

/** The group's engine search URL for a raw query. */
export function searchUrlFor(query: string, group: EngineGroup = 'web'): string {
  return getSearchEngine(group).template.replace('%s', encodeURIComponent(query));
}

/**
 * Mirrors `toUrl`'s "is this a search phrase?" rule, so the pickers know
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
