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
  onBrowserDownload,
  onBrowserNav,
  onBrowserPage,
  onBrowserPopup,
  onBrowserTitle,
  isTauri
} from '../ipc';
import { downloads } from './downloads.svelte';

/** The hard cap. Nine tabs, like the plan says — no more. */
export const MAX_TABS = 9;

/** DuckDuckGo, not Google: no account, no tracking pixel on every keystroke. */
const SEARCH_URL = 'https://duckduckgo.com/?q=';

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
  { url: 'https://duckduckgo.com', label: 'DuckDuckGo' },
  { url: 'https://groq.com', label: 'Groq' },
  { url: 'https://aistudio.google.com', label: 'Gemini' },
  { url: 'https://web.telegram.org', label: 'Telegram' }
];

/**
 * Normalise whatever the user typed into a URL.
 *
 * A bare `youtube.com` becomes `https://youtube.com` (the scheme is implied);
 * anything with whitespace or no dot becomes a DuckDuckGo search. Returns the
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
 * The favicon image source for a page URL.
 *
 * On the desktop every icon routes through the daemon's proxy (which fetches
 * `/favicon.ico` for the host once and caches it on disk) so the webview's CSP
 * stays tight — the shell never loads an arbitrary origin directly. In the dev
 * preview there is no daemon, so the icon loads straight from the network.
 * Returns `null` for a non-http(s) URL, letting the caller fall back to a
 * letter badge or the globe.
 */
export function faviconSrc(pageUrl: string): string | null {
  let origin: string;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    origin = u.origin;
  } catch {
    return null;
  }
  if (isTauri()) return `${DAEMON}/v1/favicon?url=${encodeURIComponent(origin)}`;
  return `${origin}/favicon.ico`;
}

class BrowserStore {
  tabs = $state<BrowserTab[]>([]);
  activeId = $state<string | null>(null);

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
    // the child is already showing it (the fast path would skip it).
    this.nudge?.(tab.id, tab.url, undefined, true);
    if (!this.nudge) tab.loading = false;
  }

  /**
   * Slice 3 wires this to the Rust side; `null` in the dev preview.
   *
   * `keep` — extra tab ids whose webview stays alive (collapsed) beyond
   * the show target: the tab the user just left, so switching back is
   * instant. `force` — re-navigate even if the child already shows the
   * URL (reload, address re-submit).
   */
  nudge: ((id: string, url: string, keep?: string[], force?: boolean) => void) | null = null;

  /** A history jump navigates **without** pushing a new history entry. */
  private jump(id: string, url: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.url = url;
    tab.title = hostOf(url);
    tab.loading = true;
    tab.lastActive = Date.now();
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
    // reload) — the live set never exceeds two webviews.
    const keep = prev && prev.id !== id && prev.url !== 'about:blank' ? [prev.id] : [];
    this.nudge?.(tab.id, tab.url, keep);
  }

  /** Close a tab. Closing the active one activates the neighbour (Firefox rule). */
  close(id: string): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const wasActive = this.activeId === id;
    this.tabs.splice(i, 1);
    if (wasActive) {
      // The active tab owned the only uncollapsed webview — closing it
      // must destroy that webview or it would outlive the tab in the strip.
      if (isTauri()) void browserHide(id);
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      this.activeId = next ? next.id : null;
      // Show the neighbour immediately — without this the content hole
      // went blank until the user clicked something.
      if (next) this.nudge?.(next.id, next.url);
    }
  }

  /** Navigate the active tab (or a specific one). */
  navigate(url: string, id?: string): void {
    const target = id ? this.tabs.find((t) => t.id === id) : this.active;
    if (!target) return;
    const next = toUrl(url);
    if (!next) return;
    target.url = next;
    target.title = hostOf(next);
    target.loading = true;
    target.lastActive = Date.now();
    this.activeId = target.id;
    if (next !== 'about:blank') this.push(target.id, next);
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

  wireTauri(): void {
    if (this.wired || !isTauri()) return;
    this.wired = true;

    // Every navigation the store drives (new tab, switch, address bar,
    // back/forward, reload) funnels through this one function.
    this.nudge = (id, url, keep, force) => {
      void browserShow(id, url, { keep, force });
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
      }
    });

    void onBrowserPage(({ id, url }) => {
      const tab = this.tabs.find((t) => t.id === id);
      if (!tab) return;
      tab.loading = false;
      tab.live = true;
      if (url && tab.url !== url) tab.url = url;
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
      void downloads.start(url, referer ? { referer } : undefined);
    });
  }
}

export const browser = new BrowserStore();
