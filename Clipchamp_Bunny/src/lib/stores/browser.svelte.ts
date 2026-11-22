/**
 * The in-built browser's tab model.
 *
 * Nine tabs, hard-capped. The tab's *page* is not here — it lives in a
 * native child webview owned by the Rust `browser::TabManager`; this store
 * holds only the metadata the chrome paints (url, title, favicon, live flag).
 * That split is the zero-RAM rule applied to browsing: switching modes
 * destroys this store's DOM tree, and the Rust side suspends every webview
 * that is not the active tab.
 */

import type { BrowserTab } from '../types';
import {
  browserShow,
  browserHide,
  browserStop,
  browserSetZoom,
  browserSetPinned,
  onBrowserDownload,
  onBrowserDownloadSaved,
  onBrowserExtensions,
  onBrowserNav,
  onBrowserPage,
  onBrowserPopup,
  onBrowserSpa,
  onBrowserTitle,
  onBrowserMedia,
  browserMediaState,
  isTauri,
  browserNote,
  statsGet,
  statsSet
} from '../ipc';
import { downloads } from './downloads.svelte';
import { lastTranscriptDownload } from './last-transcript-download.svelte';
import { ublock } from './ublock.svelte';
import { toast } from './toast.svelte';
import { searchUrlFor, type EngineGroup } from '../search-engines.svelte';

/** The hard cap. Nine tabs, like the plan says — no more. */
export const MAX_TABS = 9;

/**
 * Background pages kept alive beyond the active tab. Three live webviews
 * (active + two most recent) is the speed/RAM compromise: switching back is
 * a resume instead of a twelve-second YouTube reload, while tab four only
 * costs a webview once it is actually used. Rust adds pinned tabs on top.
 */
const RECENT_KEEP = 2;

/** A saved page pin (Ctrl+D). Bookmarks live on the speed dial. */
export interface Bookmark {
  url: string;
  label: string;
}

const BOOKMARKS_KEY = 't9-browser-lit.bookmarks';

/** One visited page in the Ctrl+H panel. Bounded list, newest first. */
export interface HistoryEntry {
  url: string;
  title: string;
  at: number;
}

const HISTORY_CAP = 80;
const CLOSED_CAP = 20;
/** The visit log is disk-backed: a panel that empties on restart is useless. */
const HISTORY_KEY = 't9-browser-lit.history.v1';
/** Pinned tabs, restored as tabs on the next boot. */
const PINS_KEY = 't9-browser-lit.pins.v1';
/** Exact URLs the user explicitly unpinned — they must NOT auto-pin on open. */
const UNPINNED_KEY = 't9-browser-lit.unpinned.v1';
/** Only the last three pinned sites are remembered (the strip itself holds 9). */
const MAX_PINNED_SITES = 3;
/** Keep the unpin decision list bounded — it is not a second history log. */
const UNPINNED_CAP = 24;
/** The whole tab strip, persisted in SQLite (localStorage is only a mirror). */
const SESSION_KEY = 't9-browser-lit.session.v1';

/** A pinned tab as it is written to disk: the page, not the webview. */
interface PinnedTab {
  url: string;
  title: string;
  /** When it was pinned — "last 3" means most recently pinned, not strip order. */
  at?: number;
}

function loadStoredHistory(): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is HistoryEntry => !!e && typeof (e as HistoryEntry).url === 'string')
      .slice(0, HISTORY_CAP)
      .map((e) => ({
        url: e.url,
        title: String(e.title || hostOf(e.url)),
        at: Number(e.at) || 0
      }));
  } catch {
    return [];
  }
}

function coercePins(parsed: unknown): PinnedTab[] {
  return (Array.isArray(parsed) ? parsed : [])
    .filter((p): p is PinnedTab => !!p && typeof (p as PinnedTab).url === 'string')
    .map((p) => ({
      url: p.url,
      title: String(p.title || hostOf(p.url)),
      at: Number(p.at) || 0
    }))
    .filter((p) => p.url && p.url !== 'about:blank')
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, MAX_PINNED_SITES);
}

/**
 * What a browser with no pin file at all starts with.
 *
 * YouTube is the page this browser exists for — "video chalta rahe while I
 * edit" — so the very first launch arrives with it already pinned instead of
 * making the user discover Ctrl+click. This is a **seed**, not a rule: the
 * moment a pin file exists (even an empty `[]`), the user's own pins win and
 * YouTube is never re-added behind their back.
 */
const DEFAULT_PINS: PinnedTab[] = [{ url: 'https://www.youtube.com', title: 'YouTube' }];

/**
 * Wait for `task`, but never longer than `ms`.
 *
 * `statsGet` is an IPC call whose promise can stay pending while the Rust side
 * is busy (it opens telemetry.db). A cold start's first browser open awaited
 * it *before* `showActive()`, so no webview was ever created: the tab sat on
 * "khul raha hai…" and only the reload button - which calls `nudge` directly -
 * brought the page up. The strip is metadata; it may never hold the first
 * page.
 */
function withDeadline<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    task.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

/**
 * The speed-dial sites on the new-tab page.
 *
 * These are the sites a T9 user actually opens: the editor's own neighbours
 * on the web. Favicons come from the daemon's proxy (which fetches and caches
 * them on disk — the webview itself never holds the bytes).
 */
export const SPEED_DIAL: ReadonlyArray<{ url: string; label: string }> = [
  { url: 'https://www.youtube.com', label: 'YouTube' },
  { url: 'https://www.instagram.com', label: 'Instagram' },
  { url: 'https://x.com', label: 'X' },
  { url: 'https://www.snapchat.com', label: 'Snapchat' },
  { url: 'https://web.whatsapp.com', label: 'WhatsApp' },
  { url: 'https://github.com/engrtarun/T9EditorLIT', label: 'GitHub' }
];

/**
 * Normalise whatever the user typed into a URL.
 *
 * A bare `youtube.com` becomes `https://youtube.com` (the scheme is implied);
 * anything with whitespace or no dot becomes a search. Which engine answers a
 * query depends on where the text was typed: `group = 'web'` (the address bar,
 * Brave by default) or `group = 'ai'` (the speed dial's box, Perplexity by
 * default). Returns the search URL when the input is a query, so the caller
 * never has to branch.
 */
export function toUrl(input: string, group: EngineGroup = 'web'): string {
  const raw = input.trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  // A single word or a phrase with spaces is a search; a dotted word is a host.
  if (/\s/.test(raw) || !raw.includes('.')) return searchUrlFor(raw, group);
  return 'https://' + raw;
}

/**
 * A stable-enough id for a tab: a counter is fine, the webview label just has
 * to be unique.
 *
 * The seed is time-based, not `1`. The shell document can reload on its own
 * (the WebView2 process-failure reloader; a dev Ctrl+R) while Rust still holds
 * `tab-N` webviews from before the reload. A counter that restarts at 1 would
 * then hand out a label that is already live, and the strip's new tab would
 * paint the previous owner's page - one id, two tabs.
 */
let nextId = 1 + (Date.now() % 900_000);

function makeTab(url: string): BrowserTab {
  return {
    id: String(nextId++),
    url,
    title: hostOf(url),
    favicon: null,
    live: false,
    loading: false,
    pinned: false,
    lastActive: Date.now()
  };
}

/** The host part of a URL, for a tab's placeholder title. `null` → 'New tab'. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'New tab';
  }
}

const DAEMON = 'http://127.0.0.1:7878';

/**
 * Every place an icon for `pageUrl` can come from, best first.
 *
 * The desktop app loads its own UI under a strict Content-Security-Policy, so
 * an icon is only allowed from `'self'`, the asset protocol, the daemon and
 * `https:` (the CSP lives in `tauri.conf.json`). The daemon proxy is tried
 * first because it fetches `/favicon.ico` once and caches it on disk; a direct
 * request and Google's favicon CDN cover a daemon that is not running and the
 * sites that 404 their own `/favicon.ico`. The dev preview has no daemon, so it
 * starts at the direct origin.
 *
 * The caller (see `SiteIcon.svelte`) walks the list until one image loads —
 * a blocked CSP request and a 404 both look like `onerror`, so the fallback
 * chain is the same for either.
 */
export function faviconSources(pageUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return [];
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
  const direct = `${parsed.origin}/favicon.ico`;
  const cdn = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(parsed.hostname)}`;
  const daemon = `${DAEMON}/v1/favicon?url=${encodeURIComponent(parsed.origin)}`;
  return isTauri() ? [daemon, direct, cdn] : [direct, cdn];
}

/**
 * The favicon image source for a page URL — the first candidate only.
 *
 * Kept for callers that need one URL; the UI uses `SiteIcon`, which walks the
 * whole chain.
 */
export function faviconSrc(pageUrl: string): string | null {
  return faviconSources(pageUrl)[0] ?? null;
}

class BrowserStore {
  tabs = $state<BrowserTab[]>([]);
  activeId = $state<string | null>(null);
  /**
   * The tab whose page is making noise right now — the `browser:media`
   * heartbeat Rust forwards from the page that owns the media session.
   * Its chip wears Firefox's speaker badge, so a video playing in a
   * background tab is findable without scanning every favicon.
   */
  playingId = $state<string | null>(null);

  /**
   * The last tab switch, as a direction (+1 next, −1 previous) and a counter
   * that goes up on every switch. The header chips and the browser chrome
   * key a short slide off `switchSeq` — "jab 2ungli se tab switch hoti h so
   * koi animation nahi aata" — and `dir` is what says which way it should
   * travel (a wrap-around still knows it was `next`, not `previous`).
   */
  switchDir = $state<1 | -1>(1);
  switchSeq = $state(0);

  /** Bookmarks (Ctrl+D) — persisted on this machine, shown on the dial. */
  bookmarks = $state<Bookmark[]>([]);
  private bookmarksLoaded = false;
  /** SQLite hydration ran once; localStorage is only the mirror from here. */
  private bookmarksHydrated = false;
  /** A bookmark changed while hydration was in flight — merge, never clobber. */
  private bookmarksDirty = false;

  /**
   * The bounded visit log behind the Ctrl+H panel; Ctrl+Shift+Del empties it.
   * Loaded from disk at construction so the panel is never empty after a
   * restart — the same durability the bookmarks already have.
   */
  historyLog = $state<HistoryEntry[]>(loadStoredHistory());

  /** The last three pinned sites with their exact URL, oldest → newest. */
  private pinnedSites: PinnedTab[] = [];
  /** When each live pinned tab got pinned — "last 3" is by this, not strip order. */
  private pinnedAt = new Map<string, number>();
  /** Exact URLs the user explicitly unpinned: never auto-pin them again. */
  private unpinnedUrls = new Set<string>();

  /** The Ctrl+H panel's open state. */
  historyOpen = $state(false);

  /**
   * The hamburger "Menu" sheet. It takes layout space instead of floating:
   * a native child webview always paints above the main DOM, so a popover
   * over the page would be invisible. Opening this shrinks the content rect;
   * ResizeObserver moves the page webview under it.
   */
  settingsOpen = $state(false);

  /**
   * Which search-engine picker is open, if any: `'urlbar'` (the address
   * bar's web list) or `'dial'` (the speed dial's AI list). A single
   * host-tagged value instead of two booleans so opening one picker can
   * never render the other host's panel too. The value is truthy while any
   * picker is open, which is exactly the condition BrowserView parks the
   * page on. The chosen engines are persisted by `search-engines.svelte.ts`;
   * this flag only tracks the dropdown.
   */
  searchPickerOpen = $state<'' | 'urlbar' | 'dial'>('');

  toggleSettings(): void {
    this.settingsOpen = !this.settingsOpen;
    if (this.settingsOpen) {
      this.searchPickerOpen = '';
      this.historyOpen = false;
    }
  }

  /**
   * Per-tab page zoom (0.2 … 10). Firefox keeps zoom per tab and shows the
   * percentage only while it is not 100% — the URL bar reads `zoomLevel` for
   * the active tab and paints the chip only when it differs from 1.
   */
  private zooms = $state<Record<string, number>>({});

  /** The active tab's zoom. `1` = 100%, which the UI treats as "no chip". */
  get zoomLevel(): number {
    const tab = this.active;
    return tab ? (this.zooms[tab.id] ?? 1) : 1;
  }

  /**
   * Per-tab URL history (stack + pointer), kept **out** of `BrowserTab` so
   * the Rust struct mirror stays a one-row-per-tab affair.
   *
   * Back/forward drive a `navigate` from here instead of the webview's own
   * `history.back()`: one source of truth, and the same path works in the dev
   * preview where no native webview exists. The cost — a back-jump re-loads
   * instead of restoring from bfcache — is acceptable for v1.
   */
  private histories = $state<Record<string, { stack: string[]; index: number }>>({});

  private hist(id: string): { stack: string[]; index: number } {
    return (this.histories[id] ??= { stack: [], index: -1 });
  }

  /**
   * The Ctrl+Shift+T stack: closed tabs newest-first (`plain`, private — no
   * UI reads it). Bounded like every state in this store.
   */
  private closed: { url: string; title: string; index: number; pinned?: boolean }[] = [];

  /** One new line in the Ctrl+H log — consecutive duplicates collapse. */
  private logVisit(url: string, title: string): void {
    if (!url || url === 'about:blank') return;
    if (this.historyLog[0]?.url === url) return;
    this.historyLog.unshift({ url, title, at: Date.now() });
    if (this.historyLog.length > HISTORY_CAP) this.historyLog.length = HISTORY_CAP;
    this.persistHistory();
  }

  private persistHistory(): void {
    const payload = JSON.stringify(this.historyLog);
    try {
      localStorage.setItem(HISTORY_KEY, payload);
    } catch {
      /* private mode / quota — this session's log still works */
    }
    // localStorage is only the mirror: the durable copy is SQLite `kv`, so a
    // visit (exact URL + exact millisecond) survives a webview storage wipe.
    void statsSet(HISTORY_KEY, payload);
  }

  /**
   * Merge SQLite's visit log with the localStorage mirror. Same key, newest
   * `at` wins per URL, bounded and sorted — the Ctrl+H panel then tells the
   * truth about exact URL and time after a restart.
   */
  async hydrateHistory(): Promise<void> {
    try {
      const raw = await withDeadline(statsGet(HISTORY_KEY), 1500, null);
      if (raw === null) {
        void statsSet(HISTORY_KEY, JSON.stringify(this.historyLog));
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const disk = parsed
        .filter((e): e is HistoryEntry => !!e && typeof (e as HistoryEntry).url === 'string')
        .map((e) => ({
          url: e.url,
          title: String(e.title || hostOf(e.url)),
          at: Number(e.at) || 0
        }));
      const merged = new Map<string, HistoryEntry>();
      for (const e of [...this.historyLog, ...disk]) {
        const prev = merged.get(e.url);
        if (!prev || e.at > prev.at) merged.set(e.url, e);
      }
      this.historyLog = [...merged.values()].sort((a, b) => b.at - a.at).slice(0, HISTORY_CAP);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(this.historyLog));
      } catch {
        /* private mode — the SQLite copy still wins */
      }
    } catch {
      /* no bridge / corrupt row — keep whatever localStorage gave us */
    }
  }

  private push(id: string, url: string): void {
    const h = this.hist(id);
    if (h.stack[h.index] === url) return;
    // Forward entries die the moment a new navigation branches off — the
    // browser rule everyone already has in their fingers.
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push(url);
    h.index = h.stack.length - 1;
  }

  canBack(id?: string): boolean {
    const tab = id ? this.tabs.find((t) => t.id === id) : this.active;
    if (!tab) return false;
    return (this.histories[tab.id]?.index ?? -1) > 0;
  }

  canForward(id?: string): boolean {
    const tab = id ? this.tabs.find((t) => t.id === id) : this.active;
    if (!tab) return false;
    const h = this.histories[tab.id];
    return !!h && h.index >= -1 && h.index < h.stack.length - 1;
  }

  back(): void {
    const tab = this.active;
    if (!tab) return;
    const h = this.hist(tab.id);
    if (h.index <= 0) return;
    h.index--;
    this.jump(tab.id, h.stack[h.index]);
  }

  forward(): void {
    const tab = this.active;
    if (!tab) return;
    const h = this.hist(tab.id);
    if (h.index >= h.stack.length - 1) return;
    h.index++;
    this.jump(tab.id, h.stack[h.index]);
  }

  /** Re-load the current URL (the reload button — history untouched). */
  reload(): void {
    const tab = this.active;
    if (!tab || tab.url === 'about:blank') return;
    tab.loading = true;
    // Same URL: `force` tells the native side to re-navigate even though
    // the child is already showing it (the fast path would skip it). Ctrl+F5
    // and Ctrl+Shift+R land on the same forced path — one nudge, no cache.
    this.nudge?.(tab.id, tab.url, undefined, true);
    if (!this.nudge) tab.loading = false;
  }

  /** Esc — stop a page's loading spinner (the JS-visible half of Firefox's Esc). */
  stopLoading(): void {
    const tab = this.active;
    if (!tab) return;
    tab.loading = false;
    // Native half: WebView2 stops fetching. Without it the spinner vanished
    // but the page kept downloading — a lie the user could see in Task Manager.
    if (this.wired) void browserStop(tab.id);
  }

  /** Alt+Home — the speed dial is this browser's home page. */
  goHome(): void {
    const tab = this.active;
    if (!tab) {
      this.open();
      return;
    }
    if (!tab.url || tab.url === 'about:blank') return;
    tab.url = 'about:blank';
    tab.title = 'New tab';
    tab.loading = false;
    tab.lastActive = Date.now();
    // A blank nudge sweeps the page webview — the dial is plain DOM, 0 MB.
    this.nudge?.(tab.id, 'about:blank');
  }

  /**
   * Ctrl+U — view-source round trip. Chromium (WebView2) renders
   * `view-source:` URLs natively; a second press walks back to the page.
   */
  viewSource(): void {
    const tab = this.active;
    if (!tab || !tab.url || tab.url === 'about:blank') return;
    if (tab.url.startsWith('view-source:')) {
      const real = tab.url.slice('view-source:'.length);
      tab.url = real;
      tab.title = hostOf(real);
      tab.loading = true;
      tab.lastActive = Date.now();
      this.nudge?.(tab.id, real, undefined, true);
      return;
    }
    tab.url = 'view-source:' + tab.url;
    tab.title = 'Source';
    tab.loading = true;
    tab.lastActive = Date.now();
    this.push(tab.id, tab.url);
    this.logVisit(tab.url, tab.title);
    this.nudge?.(tab.id, tab.url, undefined, true);
  }

  /**
   * Ctrl+= / Ctrl+- / Ctrl+0 — the page's own zoom, inside the child webview
   * (WebView2's scale, like Firefox's page zoom). Firefox keeps this per tab,
   * so switching back to a tab returns its zoom; a fresh tab starts at 100%.
   *
   * **10% per press**, like current Firefox — not the old 20% step that made
   * two presses skip straight past the size the user wanted. The range is
   * 30%…300% (Firefox's own), and the value is rounded to one decimal so the
   * `%` chip can never say 99% for a page that is at 100%.
   */
  applyZoom(dir: -1 | 0 | 1): void {
    const tab = this.active;
    if (!tab) return;
    const current = this.zooms[tab.id] ?? 1;
    const next =
      dir === 0 ? 1 : Math.min(3, Math.max(0.3, Math.round((current + dir * 0.1) * 10) / 10));
    this.zooms[tab.id] = Math.round(next * 100) / 100;
    void browserSetZoom(tab.id, this.zooms[tab.id]);
  }

  /** Ctrl+1..9 — the nth tab (0-based); past the end means the last tab. */
  selectIndex(n: number): void {
    if (this.tabs.length === 0) return;
    this.select(this.tabs[Math.min(n, this.tabs.length - 1)].id);
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab — cycle with wrap-around. */
  cycle(dir: -1 | 1): void {
    const n = this.tabs.length;
    if (n < 2) return;
    const i = Math.max(
      0,
      this.tabs.findIndex((t) => t.id === this.activeId)
    );
    this.select(
      this.tabs[(i + dir + n) % n].id,
      dir // the wrap still counts as next/previous, for the slide
    );
  }

  /** Ctrl+Shift+PageUp / PageDown — move the active tab within the strip. */
  moveTab(dir: -1 | 1): void {
    const tab = this.active;
    if (!tab) return;
    const i = this.tabs.findIndex((t) => t.id === tab.id);
    const j = i + dir;
    if (j < 0 || j >= this.tabs.length) return;
    this.tabs.splice(i, 1);
    this.tabs.splice(j, 0, tab);
  }

  /**
   * Ctrl+Shift+T — restore the most recently closed tab at its old slot, like
   * Firefox. Deliberately allowed past the nine-tab cap: a restore is a
   * correction, not a new visit. Returns false when the stack is empty.
   */
  reopenClosed(): boolean {
    const last = this.closed.pop();
    if (!last) return false;
    const tab = makeTab(last.url);
    tab.title = last.title;
    // A pin is part of what the tab *is*, so a restore brings it back pinned.
    // Without this, closing and reopening a pinned YouTube lost the pin and
    // the next "back to the dashboard" swept the page it was meant to keep.
    tab.pinned = last.pinned === true;
    if (tab.pinned && isTauri()) void browserSetPinned(tab.id, true);
    const i = Math.min(last.index, this.tabs.length);
    this.tabs.splice(i, 0, tab);
    if (tab.pinned) this.persistPins();
    this.activeId = tab.id;
    if (isTauri()) this.nudge?.(tab.id, tab.url);
    return true;
  }

  /** Toggle the Ctrl+H panel. */
  toggleHistory(): void {
    this.historyOpen = !this.historyOpen;
  }

  /**
   * Ctrl+Shift+Del (frontend half) — T9's own visit log and closed stack.
   * The active page's webview profile is wiped by ipc (`browserClearBrowsingData`).
   */
  clearHistory(): void {
    this.historyLog = [];
    this.closed.length = 0;
    this.persistHistory();
  }

  /* ── bookmarks (Ctrl+D) — they pin onto the speed dial ──────────────── */

  private loadBookmarks(): void {
    if (this.bookmarksLoaded) return;
    this.bookmarksLoaded = true;
    try {
      const raw = localStorage.getItem(BOOKMARKS_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) {
        this.bookmarks = parsed.filter(
          (b): b is Bookmark => !!b && typeof (b as Bookmark).url === 'string'
        );
      }
    } catch {
      /* corrupt store — the dial just starts empty beyond the built-ins */
    }
  }

  private persistBookmarks(): void {
    this.bookmarksDirty = true;
    const payload = JSON.stringify(this.bookmarks);
    try {
      localStorage.setItem(BOOKMARKS_KEY, payload);
    } catch {
      /* private mode — the SQLite copy below still wins */
    }
    // SQLite is the durable half (the same kv table the tab session uses).
    // localStorage alone forgot every bookmark on an app close — "koi tab
    // bookmark kari so wo app close per bhool jata h".
    void statsSet(BOOKMARKS_KEY, payload);
  }

  /**
   * Read the bookmarks back from SQLite once per launch. Asked at shell
   * attach (App.svelte), before the dial can ever render. localStorage is
   * read first as the synchronous mirror, then SQLite wins when it answers —
   * unless a bookmark was written while the read was in flight, which merges
   * instead of clobbering.
   */
  async hydrateBookmarks(): Promise<void> {
    if (this.bookmarksHydrated) return;
    this.bookmarksHydrated = true;
    this.loadBookmarks();
    let raw: string | null = null;
    try {
      raw = await withDeadline(statsGet(BOOKMARKS_KEY), 1500, null);
    } catch {
      return; /* no bridge — the mirror is all there is */
    }
    if (raw == null) {
      // Fresh profile: push an existing mirror up so the next boot finds it.
      try {
        const mirror = localStorage.getItem(BOOKMARKS_KEY);
        if (mirror) void statsSet(BOOKMARKS_KEY, mirror);
      } catch {
        /* blocked storage */
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; /* corrupt row — the mirror stands */
    }
    if (!Array.isArray(parsed)) return;
    const stored = parsed.filter(
      (b): b is Bookmark => !!b && typeof (b as Bookmark).url === 'string'
    );
    if (this.bookmarksDirty) {
      for (const b of stored) {
        if (!this.bookmarks.some((x) => x.url === b.url)) this.bookmarks.push(b);
      }
      return;
    }
    this.bookmarks = stored;
  }

  isBookmarked(url: string): boolean {
    this.loadBookmarks();
    return this.bookmarks.some((b) => b.url === url);
  }

  /** Ctrl+D. Returns true when the URL was ADDED (removed otherwise). */
  toggleBookmark(url: string, label: string): boolean {
    this.loadBookmarks();
    const i = this.bookmarks.findIndex((b) => b.url === url);
    if (i >= 0) {
      this.bookmarks.splice(i, 1);
      this.persistBookmarks();
      return false;
    }
    this.bookmarks.push({ url, label: label || hostOf(url) });
    this.persistBookmarks();
    return true;
  }

  removeBookmark(url: string): void {
    this.loadBookmarks();
    this.bookmarks = this.bookmarks.filter((b) => b.url !== url);
    this.persistBookmarks();
  }

  /** Ctrl+Shift+D — every open tab with a real URL becomes a pin. */
  bookmarkAllTabs(): number {
    this.loadBookmarks();
    let added = 0;
    for (const tab of this.tabs) {
      if (!tab.url || tab.url === 'about:blank') continue;
      if (this.bookmarks.some((b) => b.url === tab.url)) continue;
      this.bookmarks.push({ url: tab.url, label: hostOf(tab.url) });
      added++;
    }
    this.persistBookmarks();
    return added;
  }

  /**
   * Slice 3 wires this to the Rust side; `null` in the dev preview.
   *
   * `keep` — extra tab ids whose webview stays alive (collapsed) beyond
   * the show target: the tab the user just left, so switching back is
   * instant. `force` — re-navigate even if the child already shows the
   * URL (reload, address re-submit). `resume` — bring a live page back on
   * screen **without** navigating it; the page, not the store, is the truth
   * (YouTube moves with pushState and the store's URL can lag one beat).
   */
  nudge:
    ((id: string, url: string, keep?: string[], force?: boolean, resume?: boolean) => void) | null =
    null;

  /** A history jump navigates **without** pushing a new history entry. */
  private jump(id: string, url: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.url = url;
    tab.title = hostOf(url);
    tab.loading = true;
    tab.lastActive = Date.now();
    this.logVisit(url, tab.title);
    this.activeId = id;
    this.nudge?.(id, url, this.recent(id));
    if (!this.nudge) tab.loading = false;
  }

  /**
   * The tab ids that should stay alive (parked at 1×1) while `exclude` is on
   * screen: the most recently used real pages. This is what turns a tab
   * switch into a resume instead of a fresh navigation.
   */
  private recent(exclude: string): string[] {
    return this.tabs
      .filter((t) => t.id !== exclude && t.url && t.url !== 'about:blank')
      .sort((a, b) => b.lastActive - a.lastActive)
      .slice(0, RECENT_KEEP)
      .map((t) => t.id);
  }

  /** The active tab, or `null` when the browser has no tabs left. */
  get active(): BrowserTab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  get atCap(): boolean {
    return this.tabs.length >= MAX_TABS;
  }

  /** Open a new tab (or focus the existing new-tab page). Capped at nine. */
  open(url = ''): BrowserTab | null {
    if (this.atCap) return null;
    const tab = makeTab(url || 'about:blank');
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.autoPin(tab);
    // A new-tab page is plain DOM in the shell, so the page webview that was
    // on screen has to come off it. Without this the old tab's page kept
    // painting over the speed dial: the strip said "New tab", the address bar
    // said about:blank, and the content still showed YouTube — every Ctrl+T /
    // Ctrl+N looked like it had done nothing ("still on the previous tab").
    // The tab the user just left (plus the next most recent pages) is kept
    // parked (1×1), so switching back is still instant instead of a reload.
    const blank = !url || url === 'about:blank';
    this.nudge?.(tab.id, blank ? 'about:blank' : url, this.recent(tab.id), false, true);
    return tab;
  }

  /** Open a URL in a **new** tab, respecting the cap. Returns false at the cap. */
  openInNewTab(url: string): boolean {
    if (this.atCap) return false;
    const tab = makeTab(url);
    this.tabs.push(tab);
    this.activeId = tab.id;
    this.autoPin(tab);
    return true;
  }

  select(id: string, dir?: -1 | 1): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (this.activeId !== id) {
      const from = this.tabs.findIndex((t) => t.id === this.activeId);
      const to = this.tabs.findIndex((t) => t.id === id);
      // `dir` is authoritative (cycle knows it even across the wrap); a plain
      // click derives it from the strip, which is the honest answer there.
      this.switchDir = dir ?? (from >= 0 && to > from ? 1 : -1);
      this.switchSeq++;
    }
    this.activeId = id;
    tab.lastActive = Date.now();
    // Selecting a tab brings its page on screen. The most recently used tabs
    // (three live webviews total) stay alive but collapsed, so switching
    // back is instant (no reload). `resume`: a live page is shown where it
    // actually is, never re-navigated from the store's (possibly one beat
    // stale) URL.
    this.nudge?.(tab.id, tab.url, this.recent(id), false, true);
  }

  /** Close a tab. Closing the active one activates the neighbour (Firefox rule). */
  close(id: string): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const dying = this.tabs[i];
    // Ctrl+Shift+T must be able to bring this back — real pages only.
    if (dying.url && dying.url !== 'about:blank') {
      this.closed.push({ url: dying.url, title: dying.title, index: i, pinned: dying.pinned });
      if (this.closed.length > CLOSED_CAP) this.closed.shift();
    }
    const wasActive = this.activeId === id;
    this.tabs.splice(i, 1);
    if (this.playingId === id) this.playingId = null;
    if (dying.pinned) this.persistPins();
    if (wasActive) {
      // The active tab owned the only uncollapsed webview — closing it
      // must destroy that webview or it would outlive the tab in the strip.
      if (isTauri()) void browserHide(id);
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      this.activeId = next ? next.id : null;
      // Show the neighbour immediately — without this the content hole
      // went blank until the user clicked something. It is resumed, not
      // re-navigated: its page may have moved with pushState while hidden.
      if (next) this.nudge?.(next.id, next.url, this.recent(next.id), false, true);
      // The keys must never be left on the webview that just died. The diag
      // log caught exactly that: `closeTab` fired once, then NOTHING for 58
      // seconds — every later Ctrl+W landed on a destroyed child HWND, Windows
      // played its default beep and the tab stayed open ("sirf ek tab hi
      // band hui, baki pe win11 ka tudunn sa bgm baja"). Hand focus back to
      // the shell so the next chord is heard here, whatever the state below.
      if (typeof window !== 'undefined') window.focus();
    }
  }

  /**
   * Leaving the browser: collapse the blank tabs nobody touched into one.
   *
   * "if user open multi home pages on browser toh jab wo studio ya app home
   * per jaye toh sirf ek hi reh jaye" — four identical speed-dial tabs are
   * not four decisions, they are one decision made four times. A tab counts
   * as TOUCHED when it has a real page, is pinned, or is playing: that is
   * the set the user named ("url likhna etc etc ya pin"). The survivor is
   * the active tab when it is itself an untouched blank, otherwise the first
   * one. Nothing here creates or navigates anything — this only trims.
   */
  pruneIdleTabs(): void {
    const blank = (t: BrowserTab): boolean => !t.url || t.url === 'about:blank';
    const idle = this.tabs.filter((t) => !t.pinned && blank(t));
    if (idle.length <= 1) return;
    const active = this.active;
    const keep = active && !active.pinned && blank(active) ? active : idle[0];
    for (const tab of idle) {
      if (tab.id === keep.id) continue;
      const i = this.tabs.findIndex((t) => t.id === tab.id);
      if (i < 0) continue;
      // Spliced, not `close()`: an untouched blank has no webview to hide and
      // must not move the selection — the browser is already off screen and
      // the next open should land exactly where the user left it.
      this.tabs.splice(i, 1);
      if (this.playingId === tab.id) this.playingId = null;
    }
  }

  /**
   * Navigate the active tab (or a specific one).
   *
   * Adopt rule: with **no tab open at all** — a fresh browser sitting on
   * the speed dial — the address bar, a speed-dial card and the popup
   * fallback all land here. A click that navigates must never evaporate,
   * so instead of a silent return the URL opens the browser's first tab.
   * That was the v1 bug: every search keystroke, pasted link and dial
   * card did literally nothing while `tabs` was empty.
   */
  navigate(url: string, id?: string): void {
    let target: BrowserTab | undefined;
    if (id) {
      target = this.tabs.find((t) => t.id === id);
    } else if (this.active) {
      target = this.active;
    } else if (this.atCap) {
      return; // nine tabs and none focused: refresh by opening one from the strip
    } else {
      const fresh = makeTab('');
      this.tabs.push(fresh);
      this.activeId = fresh.id;
      target = fresh;
    }
    if (!target) return;
    const next = toUrl(url);
    if (!next) return;
    if (next === 'about:blank' && !id) {
      // An empty submit has nothing to load: leave the fresh dial tab.
      if (target.url === '') target.url = 'about:blank';
      return;
    }
    target.url = next;
    target.title = hostOf(next);
    target.loading = true;
    target.lastActive = Date.now();
    this.activeId = target.id;
    this.autoPin(target);
    if (next !== 'about:blank') {
      this.push(target.id, next);
      this.logVisit(next, target.title);
    }
    // The native webview follows (Slice 3); in the dev preview the loading
    // flag is cleared immediately because there is no page to wait for.
    // `force`: a same-URL submit must reload, not hit the nothing-to-do
    // fast path — browser rule.
    //
    // NOTE: the webview this navigates may be a KEPT (collapsed) child —
    // browser_show un-collapses the target before reacting to `force`.
    this.nudge?.(target.id, next, undefined, true);
    if (!this.nudge) target.loading = false;
  }

  /** The page finished loading — clear the spinner, take its title. */
  loaded(id: string, title?: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.loading = false;
    if (title) tab.title = title;
  }

  /** The Rust side reports a webview was created / destroyed for this tab. */
  setLive(id: string, live: boolean): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) tab.live = live;
  }

  setFavicon(id: string, favicon: string | null): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab) tab.favicon = favicon;
  }

  /**
   * Pin / unpin a tab. A pinned tab's native webview stays alive while it is
   * not the active tab (parked at 1×1, low memory), so audio keeps playing —
   * Firefox's pinned tab, aimed at "YouTube chalta rahe while I edit".
   *
   * Not to be confused with a bookmark (Ctrl+D): that is a link on the speed
   * dial, this is the live page. Pins are written to disk (URL + title) and
   * restored as tabs on the next boot — re-pinning the same three sites every
   * launch was the annoyance the user reported.
   */
  setPinned(id: string, pinned: boolean): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || tab.pinned === pinned) return;

    if (pinned) {
      // Three is the memory cap, not the strip cap (nine). Pinning a fourth
      // drops the oldest pin so the remembered list never grows past three.
      const others = this.tabs
        .filter((t) => t.pinned && t.id !== id)
        .sort((a, b) => (this.pinnedAt.get(a.id) ?? 0) - (this.pinnedAt.get(b.id) ?? 0));
      while (others.length >= MAX_PINNED_SITES) {
        const oldest = others.shift();
        if (!oldest) break;
        oldest.pinned = false;
        this.pinnedAt.delete(oldest.id);
        if (isTauri()) void browserSetPinned(oldest.id, false);
      }
      this.pinnedAt.set(id, Date.now());
      // Re-pinning the same exact URL cancels a previous unpin decision.
      this.unpinnedUrls.delete(tab.url);
      this.persistUnpinned();
    } else {
      this.pinnedAt.delete(id);
      // An explicit unpin is a decision, not just a missing pin. Remember the
      // exact URL so opening it again does not silently re-pin it.
      if (tab.url && tab.url !== 'about:blank') {
        this.unpinnedUrls.add(tab.url);
        if (this.unpinnedUrls.size > UNPINNED_CAP) {
          const first = this.unpinnedUrls.values().next().value;
          if (first) this.unpinnedUrls.delete(first);
        }
        this.persistUnpinned();
      }
    }

    tab.pinned = pinned;
    this.persistPins();
    if (isTauri()) void browserSetPinned(id, pinned);
  }

  private persistUnpinned(): void {
    const payload = JSON.stringify([...this.unpinnedUrls]);
    try {
      localStorage.setItem(UNPINNED_KEY, payload);
    } catch {
      /* private mode / quota — the SQLite copy below still wins */
    }
    void statsSet(UNPINNED_KEY, payload);
  }

  /**
   * Remember the last three pinned sites verbatim (exact URL + title + when).
   * localStorage is the synchronous mirror; SQLite is the durable half.
   */
  private persistPins(): void {
    const pins: PinnedTab[] = this.tabs
      .filter((t) => t.pinned && t.url && t.url !== 'about:blank')
      .map((t) => ({ url: t.url, title: t.title, at: this.pinnedAt.get(t.id) ?? 0 }))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, MAX_PINNED_SITES);
    this.pinnedSites = pins;
    const payload = JSON.stringify(pins);
    try {
      localStorage.setItem(PINS_KEY, payload);
    } catch {
      /* private mode / quota — the SQLite copy below still wins */
    }
    void statsSet(PINS_KEY, payload);
  }

  /**
   * Opening a remembered site pins it automatically — unless the user
   * explicitly unpinned it last time. Exact URL match, capped at three.
   */
  private autoPin(tab: BrowserTab): void {
    if (!tab.url || tab.url === 'about:blank' || tab.pinned) return;
    if (this.unpinnedUrls.has(tab.url)) return;
    if (!this.pinnedSites.some((p) => p.url === tab.url)) return;
    if (this.tabs.filter((t) => t.pinned).length >= MAX_PINNED_SITES) return;
    tab.pinned = true;
    this.pinnedAt.set(tab.id, Date.now());
    this.persistPins();
    if (isTauri()) void browserSetPinned(tab.id, true);
  }

  /**
   * Bring back the pinned tabs from the last session. Called once, right
   * after `wireTauri`, before the first `showActive`: a browser that boots
   * with zero tabs is the only moment restoring makes sense.
   *
   * SQLite is asked first (localStorage is only the mirror), so a pin
   * survives an app close even when the webview's storage does not.
   *
   * Restored tabs are marked pinned in Rust too, so the first tab switch
   * parks them awake instead of treating them as ordinary background tabs.
   */
  async restorePinned(): Promise<void> {
    // Load the explicit-unpin decisions first, even when a saved session has
    // already filled the strip — otherwise a site the user unpinned could be
    // auto-pinned the next time it is opened.
    try {
      const mirror = localStorage.getItem(UNPINNED_KEY);
      const raw = await withDeadline(statsGet(UNPINNED_KEY), 1500, null);
      const parsed: unknown = JSON.parse(raw ?? mirror ?? '[]');
      if (Array.isArray(parsed)) {
        this.unpinnedUrls = new Set(parsed.filter((u): u is string => typeof u === 'string'));
      }
    } catch {
      /* no bridge / corrupt row — an empty decision list is the safe default */
    }
    if (this.tabs.length > 0) {
      // A persisted session already owns the strip; keep the remembered list
      // in sync with the pins actually on screen instead of rebuilding it.
      // Older sessions may hold more than three pins — trim them to the cap.
      const pinned = this.tabs.filter((t) => t.pinned);
      for (const t of pinned.slice(MAX_PINNED_SITES)) {
        t.pinned = false;
        if (isTauri()) void browserSetPinned(t.id, false);
      }
      for (const t of this.tabs) if (t.pinned) this.pinnedAt.set(t.id, Date.now());
      this.persistPins();
      return;
    }
    // `null` = no pin file anywhere (a fresh install). `[]` = the user unpinned
    // everything, and that decision is respected.
    let pins: PinnedTab[] | null = null;
    try {
      const mirror = localStorage.getItem(PINS_KEY);
      if (mirror !== null) pins = coercePins(JSON.parse(mirror));
    } catch {
      /* private mode — the SQLite copy below still answers */
    }
    try {
      const raw = await withDeadline(statsGet(PINS_KEY), 1500, null);
      if (raw != null) pins = coercePins(JSON.parse(raw));
      else if (pins && pins.length) {
        // An older install wrote only the mirror — bring it forward.
        void statsSet(PINS_KEY, JSON.stringify(pins));
      }
    } catch {
      /* no bridge / corrupt row — the mirror stands */
    }
    if (pins === null) {
      // First run: start with YouTube pinned. Write the seed down immediately,
      // so unpinning it later is remembered as an empty list, not as "no file".
      pins = DEFAULT_PINS.slice();
      const payload = JSON.stringify(pins);
      try {
        localStorage.setItem(PINS_KEY, payload);
      } catch {
        /* private mode */
      }
      void statsSet(PINS_KEY, payload);
    }
    // A site the user explicitly unpinned is never restored, even if an old
    // pin file still listed it.
    const restore = pins.filter((p) => !this.unpinnedUrls.has(p.url));
    this.pinnedSites = restore;
    if (this.tabs.length > 0 || restore.length === 0) {
      this.persistPins();
      return;
    }
    for (const pin of restore) {
      const tab = makeTab(pin.url);
      tab.title = pin.title || hostOf(pin.url);
      tab.pinned = true;
      this.tabs.push(tab);
      this.push(tab.id, pin.url);
      this.pinnedAt.set(tab.id, pin.at || Date.now());
      if (isTauri()) void browserSetPinned(tab.id, true);
    }
    this.activeId = this.tabs[0].id;
    this.landOnDial();
    this.persistPins();
  }

  /* ------------------------------------------------ tab session (disk) */

  /**
   * Where the strip is on disk: SQLite's `kv` table, the same durable store
   * the project list and transcripts already use. localStorage is written
   * too, but only as a synchronous mirror for the next mount.
   */
  private sessionRestored = false;
  /** True only after the restore finished; writing before that would erase it. */
  private sessionReady = false;
  private sessionWrites = 0;

  /**
   * Pinned tabs restored from the pin file stay in the strip but do not become
   * the active page on a cold start: a pinned YouTube tab must not start
   * playing before the user has even opened the browser. `activeId = null` is
   * the store's "dial" state (the same one a brand-new browser has).
   */
  private landOnDial(): void {
    if (this.tabs.length === 0) return;
    this.activeId = null;
  }

  /**
   * Snapshot the strip after every change (tab add/close/switch/navigate).
   *
   * Called from one `$effect` in `BrowserView`, which reads `tabs` and
   * `activeId` here, so runes track every mutation without six call sites
   * that can forget one. Writes coalesce to one per tick because a switch
   * updates the strip and the active id in the same batch.
   *
   * Two guards, both learned the hard way: nothing is written until the
   * restore has *finished* (the effect fires while `statsGet` is still in
   * flight, and an empty strip would overwrite the saved one), and an empty
   * strip is never written at all (closing the browser view is not the same
   * as "the user has no tabs").
   */
  persistSession(): void {
    if (!this.sessionReady) return;
    const tabs = this.tabs
      .filter((t) => t.url && t.url !== 'about:blank')
      .map((t) => ({ url: t.url, title: t.title, pinned: t.pinned }));
    if (!tabs.length) return;
    const at = this.tabs.findIndex((t) => t.id === this.activeId);
    const payload = JSON.stringify({ tabs, active: at < 0 ? 0 : at });
    try {
      localStorage.setItem(SESSION_KEY, payload);
    } catch {
      /* private mode / quota - the SQLite copy below still wins */
    }
    const seq = ++this.sessionWrites;
    queueMicrotask(() => {
      if (seq !== this.sessionWrites) return;
      void statsSet(SESSION_KEY, payload);
    });
  }

  /**
   * Read the saved strip on launch. Runs once per launch.
   *
   * A cold start lands on the speed dial (the Home tab), never on the page
   * that happened to be open last: restoring the strip reopened a stuck
   * YouTube tab on every launch, so the browser opened on YouTube and Home
   * was never seen. The saved entries are kept as restore points instead -
   * Ctrl+Shift+T brings them back one at a time - and no webview is created
   * here, which also keeps a saved video from playing behind the dashboard.
   *
   * SQLite is asked first; localStorage is the fallback for a fresh profile
   * or a dev build without the command bridge.
   */
  async restoreSession(): Promise<void> {
    if (this.sessionRestored) return;
    this.sessionRestored = true;
    try {
      if (this.tabs.length > 0) return;

      let raw: string | null = null;
      try {
        raw = await withDeadline(statsGet(SESSION_KEY), 1500, null);
      } catch {
        /* no bridge */
      }
      if (!raw) {
        try {
          raw = localStorage.getItem(SESSION_KEY);
        } catch {
          /* blocked storage */
        }
      }
      if (!raw) {
        await this.restorePinned();
        return;
      }

      let stored: { tabs?: unknown; active?: unknown };
      try {
        stored = JSON.parse(raw) as { tabs?: unknown; active?: unknown };
      } catch {
        await this.restorePinned();
        return;
      }
      if (!Array.isArray(stored.tabs)) {
        await this.restorePinned();
        return;
      }

      const saved: { url: string; title: string; index: number; pinned?: boolean }[] = [];
      for (const entry of stored.tabs) {
        if (saved.length >= MAX_TABS) break;
        if (!entry || typeof entry !== 'object') continue;
        const { url, title, pinned } = entry as Record<string, unknown>;
        if (typeof url !== 'string' || !url || url === 'about:blank') continue;
        saved.push({
          url,
          title: typeof title === 'string' && title ? title : hostOf(url),
          index: saved.length,
          pinned: pinned === true
        });
      }
      if (saved.length === 0) {
        await this.restorePinned();
        return;
      }
      // App band karke kholne par purane tab WAPAS NAHI AATE — "jab mene app
      // band karke khola so old tab close kyo nahi hue?". Sirf PINNED entries
      // strip me wapas aati hain (pin = user ka action, wahi durable rehna
      // chahiye; `restorePinned` neeche unhe tab banaati hai). Baaki sab
      // entries Ctrl+Shift+T ke closed-stack me chali jaati hain: strip me
      // kuch nahi dikhta, aur phir bhi wapas layi ja sakti hain. `activeId`
      // NULL rehti hai, so the browser opens on the dial with nothing
      // autoplaying — a fresh start that still remembers.
      for (const entry of saved) {
        if (entry.pinned) continue;
        this.closed.push({ url: entry.url, title: entry.title, index: entry.index, pinned: false });
      }
      if (this.closed.length > CLOSED_CAP) {
        this.closed.splice(0, this.closed.length - CLOSED_CAP);
      }
      await this.restorePinned();
    } finally {
      // Only now may `persistSession` write: the mount effect fires while the
      // `statsGet` above is still in flight, and an empty strip would erase
      // the very session this launch is supposed to bring back. A tab opened
      // during the await (tools panel -> browser) is saved here instead of
      // being lost.
      this.sessionReady = true;
      if (this.tabs.length > 0) this.persistSession();
    }
  }

  /** The menu's Pin/Unpin row. Returns the tab's state after the toggle. */
  togglePin(): boolean {
    const tab = this.active;
    if (!tab) return false;
    this.setPinned(tab.id, !tab.pinned);
    return tab.pinned;
  }

  /**
   * Firefox's Duplicate Tab: the same URL in the next slot, active, with the
   * pin carried over (a pinned video is duplicated as a pinned tab). The page
   * loads fresh rather than cloning the webview — two live copies of a page is
   * the one thing the memory budget does not allow.
   */
  duplicateTab(id?: string): boolean {
    const src = id ? this.tabs.find((t) => t.id === id) : this.active;
    if (!src || this.atCap) return false;
    const at = this.tabs.findIndex((t) => t.id === src.id);
    const copy = makeTab(src.url);
    copy.title = src.title;
    copy.pinned = src.pinned;
    this.tabs.splice(at + 1, 0, copy);
    this.activeId = copy.id;
    this.push(copy.id, copy.url);
    if (copy.pinned && isTauri()) void browserSetPinned(copy.id, true);
    this.nudge?.(copy.id, copy.url);
    return true;
  }

  /**
   * The LRU pick for the next suspension: the oldest *live* tab that is not
   * the active one. `null` when there is nothing to suspend (fewer than two
   * live tabs) — the watchdog calls this, and the 500 MB budget holds because
   * the active tab is never the victim.
   */
  lruSuspendCandidate(): BrowserTab | null {
    const live = this.tabs
      .filter((t) => t.live && t.id !== this.activeId)
      .sort((a, b) => a.lastActive - b.lastActive);
    return live[0] ?? null;
  }

  /**
   * Wire the store to the native side (once, on mount). No-ops in the dev
   * preview so the browser shell stays usable without a webview.
   */
  private wired = false;
  /**
   * One toast per failure burst. A blank tab clicked five times used to stack
   * five identical walls of native error text over the page; the same error
   * within a few seconds now only bumps the clock.
   */
  private lastNavError = { message: '', at: 0 };

  wireTauri(): void {
    if (this.wired || !isTauri()) return;
    this.wired = true;

    // Every navigation the store drives (new tab, switch, address bar,
    // back/forward, reload) funnels through this one function. A failure
    // that used to be swallowed now reaches the user — once per burst,
    // with a sentence that says what to do instead of a raw HRESULT.
    this.nudge = (id, url, keep, force, resume) => {
      browserShow(id, url, { keep, force, resume }).catch((err) => {
        const tab = this.tabs.find((t) => t.id === id);
        if (tab) tab.loading = false;
        const message = String(err);
        const now = Date.now();
        if (this.lastNavError.message === message && now - this.lastNavError.at < 4000) {
          this.lastNavError.at = now;
          return;
        }
        this.lastNavError = { message, at: now };
        toast.push('warn', friendlyTabError(message));
      });
    };

    // The page finished loading — clear the spinner, take its final URL
    // (after redirects) and its title.
    void onBrowserNav(({ id, url }) => {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab) return;
      // A self-navigation is a new history entry (link click, redirect).
      if (tab.url !== url) {
        tab.url = url;
        tab.title = hostOf(url);
        this.push(id, url);
        this.logVisit(url, tab.title);
        this.autoPin(tab);
        if (tab.pinned) this.persistPins();
      }
    });

    void onBrowserPage(({ id, url }) => {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab) return;
      tab.loading = false;
      tab.live = true;
      if (url && tab.url !== url) tab.url = url;
    });

    // An SPA moved the page without a navigation (YouTube video → video):
    // `history.pushState` changes the document URL and WebView2 fires no
    // event for it. The shim reports it, so the strip stays honest — and a
    // pinned tab no longer looks like it is still on the video it started
    // from, which is what sent it back home on remount.
    void onBrowserSpa(({ id, url }) => {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab || !url || tab.url === url) return;
      tab.url = url;
      tab.title = hostOf(url);
      tab.loading = false;
      this.push(id, url);
      this.logVisit(url, tab.title);
      this.autoPin(tab);
      if (tab.pinned) this.persistPins();
    });

    // The page's own <title>: the strip and downloads panel prefer it over
    // the hostname, like every real browser. Hostname stays the fallback.
    void onBrowserTitle(({ id, title }) => {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab || !title) return;
      tab.title = title;
      if (tab.pinned) this.persistPins();
    });

    // The page's media session — which tab is playing, and whether it still
    // is. `none`/`paused` both take the badge away; a tab id we no longer
    // have (closed during playback) simply never matches.
    void onBrowserMedia((snap) => {
      this.playingId = snap.state === 'playing' ? snap.tab : null;
    });
    void browserMediaState().then((snap) => {
      if (snap && snap.state === 'playing') this.playingId = snap.tab;
    });

    // A page asked for a new window — target=_blank (search results use it),
    // Ctrl+click, window.open. Rust denied the native popup; here the URL
    // becomes a tab in the strip, so the link stays inside the app. At the
    // nine-tab cap the current tab navigates instead (never shell out).
    void onBrowserPopup(({ url }) => {
      // The tab that opened the popup stays alive (collapsed) — going
      // "back" to it is instant, which is exactly the search → results →
      // open → back flow.
      const opener = this.active;
      const keep = opener && opener.url !== 'about:blank' ? [opener.id] : [];
      if (this.openInNewTab(url)) {
        const tab = this.active;
        if (tab) {
          tab.title = hostOf(url);
          tab.loading = true;
          this.push(tab.id, url);
          this.logVisit(url, tab.title);
          this.nudge?.(tab.id, url, keep);
          if (!this.nudge) tab.loading = false;
        }
      } else {
        this.navigate(url);
      }
    });

    // WebView2 wanted to download a file; Rust cancelled it and handed the
    // URL here. The daemon's multi-segment downloader owns the bytes now.
    void onBrowserDownload(({ url, referer }) => {
      // A refused start (expired link, a host that blocks probes) lands in the
      // downloads panel as a row; without this catch it was an unhandled
      // rejection and the click simply did nothing.
      downloads.start(url, referer ? { referer } : undefined).catch(() => {});
    });

    // A `blob:`/`data:` download (ElevenLabs' export buttons) is saved by
    // WebView2 itself — a URL that only exists inside the page cannot be
    // fetched by the daemon. Remembering the path is what lets the transcript
    // panel offer the just-saved file instead of sending the user to Explorer.
    void onBrowserDownloadSaved(({ url, path, success }) => {
      if (!success || !path) return;
      const name = lastTranscriptDownload.note(path, url);
      if (name) toast.push('info', `Transcript saved: ${name}`, 4000);
    });

    // WebView2's own extension list — the only honest answer to "is uBlock
    // running?". The unpacked folder proves the download, not the load.
    void onBrowserExtensions((p) => {
      ublock.noteRuntime(p);
    });
  }

  /**
   * Make the native side show the active tab.
   *
   * A tab can be created **before** the browser view mounts — the tools panel
   * opens a link, then switches the app to the browser, so `wireTauri` has not
   * run yet and the `nudge` hook is still null. Without this the store would
   * hold a URL no webview ever shows, and the user would stare at the loading
   * placeholder. Called once, right after wiring.
   */
  showActive(): void {
    const tab = this.active;
    // Every skip says why. The log showed a rect and then nothing at all, so a
    // page that never got a webview was indistinguishable from one whose show
    // was refused - and that is what made "atak" so hard to pin down.
    if (!tab) {
      void browserNote('showActive -> skipped (no active tab)');
      return;
    }
    if (!this.nudge) {
      void browserNote(`showActive -> skipped (not wired), tab ${tab.id}`);
      return;
    }
    if (!tab.url || tab.url === 'about:blank') {
      void browserNote(`showActive -> skipped (blank), tab ${tab.id}`);
      return;
    }
    // Resume, never navigate: the browser view was unmounted and remounted,
    // and the tab's page may be further along than the store knows. This is
    // the pinned-YouTube case: leaving for the editor and coming back must
    // not reload the video.
    void browserNote(`showActive -> resume ${tab.id} ${tab.url}`);
    this.nudge(tab.id, tab.url, this.recent(tab.id), false, true);
  }
}

/**
 * Turn the native failure into one actionable sentence.
 *
 * The raw string stays in `browser-diag.log`; the user needs to know whether
 * to retry, restart, or wait — not the COM HRESULT. 0x8007139F is the
 * environment-mismatch error that used to blank every tab, so it gets its
 * own text even though the code path now prevents it.
 */
function friendlyTabError(raw: string): string {
  if (/0x8007139F/i.test(raw)) {
    return 'Tab khul nahi paya (WebView2 state error 0x8007139F) — app restart karke try karo.';
  }
  if (/content area was not measured|rect 0x0/i.test(raw)) {
    return 'Browser area abhi measure nahi hui — ek baar phir try karo.';
  }
  return `Tab khul nahi paya: ${raw}`;
}

export const browser = new BrowserStore();
