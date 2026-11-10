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
  onBrowserExtensions,
  onBrowserNav,
  onBrowserPage,
  onBrowserPopup,
  onBrowserSpa,
  onBrowserTitle,
  isTauri
} from '../ipc';
import { downloads } from './downloads.svelte';
import { ublock } from './ublock.svelte';
import { toast } from './toast.svelte';

/** The hard cap. Nine tabs, like the plan says — no more. */
export const MAX_TABS = 9;

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

/** Brave Search, not Google: no account, no ad profile on every keystroke. */
const SEARCH_URL = 'https://search.brave.com/search?q=';

/**
 * The speed-dial sites on the new-tab page.
 *
 * These are the sites a T9 user actually opens: the editor's own neighbours
 * on the web. Favicons come from the daemon's proxy (which fetches and caches
 * them on disk — the webview itself never holds the bytes).
 */
export const SPEED_DIAL: ReadonlyArray<{ url: string; label: string }> = [
  { url: 'https://www.youtube.com', label: 'YouTube' },
  { url: 'https://github.com/engrtarun/T9EditorLIT', label: 'GitHub' },
  { url: 'https://search.brave.com', label: 'Brave' },
  { url: 'https://groq.com', label: 'Groq' },
  { url: 'https://aistudio.google.com', label: 'Gemini' },
  { url: 'https://web.telegram.org', label: 'Telegram' }
];

/**
 * Normalise whatever the user typed into a URL.
 *
 * A bare `youtube.com` becomes `https://youtube.com` (the scheme is implied);
 * anything with whitespace or no dot becomes a Brave search. Returns the
 * search URL when the input is a query, so the caller never has to branch.
 */
export function toUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  // A single word or a phrase with spaces is a search; a dotted word is a host.
  if (/\s/.test(raw) || !raw.includes('.')) return SEARCH_URL + encodeURIComponent(raw);
  return 'https://' + raw;
}

/** A stable-enough id for a tab: a counter is fine, the webview label just has to be unique. */
let nextId = 1;

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

  /** Bookmarks (Ctrl+D) — persisted on this machine, shown on the dial. */
  bookmarks = $state<Bookmark[]>([]);
  private bookmarksLoaded = false;

  /** The bounded visit log behind the Ctrl+H panel; Ctrl+Shift+Del empties it. */
  historyLog = $state<HistoryEntry[]>([]);

  /** The Ctrl+H panel's open state. */
  historyOpen = $state(false);

  /**
   * The hamburger "Menu" sheet. It takes layout space instead of floating:
   * a native child webview always paints above the main DOM, so a popover
   * over the page would be invisible. Opening this shrinks the content rect;
   * ResizeObserver moves the page webview under it.
   */
  settingsOpen = $state(false);

  toggleSettings(): void {
    this.settingsOpen = !this.settingsOpen;
    if (this.settingsOpen) this.historyOpen = false;
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
  private closed: { url: string; title: string; index: number }[] = [];

  /** One new line in the Ctrl+H log — consecutive duplicates collapse. */
  private logVisit(url: string, title: string): void {
    if (!url || url === 'about:blank') return;
    if (this.historyLog[0]?.url === url) return;
    this.historyLog.unshift({ url, title, at: Date.now() });
    if (this.historyLog.length > HISTORY_CAP) this.historyLog.length = HISTORY_CAP;
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
   */
  applyZoom(dir: -1 | 0 | 1): void {
    const tab = this.active;
    if (!tab) return;
    const current = this.zooms[tab.id] ?? 1;
    const next = dir === 0 ? 1 : Math.min(10, Math.max(0.2, current + dir * 0.2));
    // Two decimals: `1 + 0.2 - 0.2` is 0.9999999999999999 in binary floating
    // point, which would paint "100%" through the `!== 1` test or "99%"
    // through a round — the chip must say exactly what the page shows.
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
    this.select(this.tabs[(i + dir + n) % n].id);
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
    const i = Math.min(last.index, this.tabs.length);
    this.tabs.splice(i, 0, tab);
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
    try {
      localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(this.bookmarks));
    } catch {
      /* private mode — the dial keeps working, pins just don't persist */
    }
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
    this.nudge?.(id, url);
    if (!this.nudge) tab.loading = false;
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
    return tab;
  }

  /** Open a URL in a **new** tab, respecting the cap. Returns false at the cap. */
  openInNewTab(url: string): boolean {
    if (this.atCap) return false;
    const tab = makeTab(url);
    this.tabs.push(tab);
    this.activeId = tab.id;
    return true;
  }

  select(id: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const prev = this.active;
    this.activeId = id;
    tab.lastActive = Date.now();
    // Selecting a tab brings its page on screen. The tab the user just
    // left stays alive but collapsed, so switching back is instant (no
    // reload) — the live set never exceeds two webviews. `resume`: a live
    // page is shown where it actually is, never re-navigated from the
    // store's (possibly one beat stale) URL.
    const keep = prev && prev.id !== id && prev.url !== 'about:blank' ? [prev.id] : [];
    this.nudge?.(tab.id, tab.url, keep, false, true);
  }

  /** Close a tab. Closing the active one activates the neighbour (Firefox rule). */
  close(id: string): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const dying = this.tabs[i];
    // Ctrl+Shift+T must be able to bring this back — real pages only.
    if (dying.url && dying.url !== 'about:blank') {
      this.closed.push({ url: dying.url, title: dying.title, index: i });
      if (this.closed.length > CLOSED_CAP) this.closed.shift();
    }
    const wasActive = this.activeId === id;
    this.tabs.splice(i, 1);
    if (wasActive) {
      // The active tab owned the only uncollapsed webview — closing it
      // must destroy that webview or it would outlive the tab in the strip.
      if (isTauri()) void browserHide(id);
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      this.activeId = next ? next.id : null;
      // Show the neighbour immediately — without this the content hole
      // went blank until the user clicked something. It is resumed, not
      // re-navigated: its page may have moved with pushState while hidden.
      if (next) this.nudge?.(next.id, next.url, undefined, false, true);
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
   * dial, this is the live page. Session-only, by design — a restart starts
   * with no pins.
   */
  setPinned(id: string, pinned: boolean): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || tab.pinned === pinned) return;
    tab.pinned = pinned;
    if (isTauri()) void browserSetPinned(id, pinned);
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
    });

    // The page's own <title>: the strip and downloads panel prefer it over
    // the hostname, like every real browser. Hostname stays the fallback.
    void onBrowserTitle(({ id, title }) => {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab || !title) return;
      tab.title = title;
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
    if (!tab || !this.nudge) return;
    if (!tab.url || tab.url === 'about:blank') return;
    // Resume, never navigate: the browser view was unmounted and remounted,
    // and the tab's page may be further along than the store knows. This is
    // the pinned-YouTube case: leaving for the editor and coming back must
    // not reload the video.
    this.nudge(tab.id, tab.url, undefined, false, true);
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
