/*
 * T9's document-start shim for page webviews.
 *
 * Two jobs, both of which need to run before the page's own scripts:
 *
 *   1. New-window links. `target=_blank`, Ctrl/Cmd/Shift-click, middle-click
 *      and `window.open` all become one `{ t9: 'open', url }` message. Rust
 *      turns that into a tab in the strip, so a link never leaves the app.
 *      (Before this, a plain `target=_blank` anchor did nothing at all:
 *      WebView2 raised no `newWindowRequested`, so Rust never heard about it.)
 *
 *   2. Keyboard. The page webview (not the app shell) owns the keyboard once
 *      the user clicks a page, so the Svelte keydown handler never sees these.
 *      WebView2's own accelerators are turned off in Rust; this map then sends
 *      `{ t9: 'key', action, value }` for the same Firefox bindings as
 *      src/lib/browser-keys.ts. Action names and the value meaning are the
 *      contract between the two; unknown actions are ignored by the app.
 *
 * Messages go over WebView2's `chrome.webview.postMessage` bridge. That is
 * deliberately not a navigation to a fake URL: a navigation would fire the
 * page's `beforeunload`, and a "Leave site?" prompt on every Ctrl+T is not a
 * browser.
 */
(() => {
  'use strict';
  if (window.__t9Shim) return;
  window.__t9Shim = true;

  const bridge = window.chrome && window.chrome.webview;
  if (!bridge || typeof bridge.postMessage !== 'function') return;
  const send = (msg) => {
    try {
      bridge.postMessage(JSON.stringify(msg));
    } catch (e) {
      /* the webview is tearing down */
    }
  };

  /* ── SPA URL changes ─────────────────────────────────────────────────
   * YouTube moves from one video to the next with history.pushState: the
   * document never navigates, so WebView2's navigation event never fires and
   * the tab strip keeps showing the old URL. That stale URL is also what made
   * a pinned video jump back to the home page when the browser view was
   * remounted. Report every real URL change to Rust; it updates the tab.
   */
  let lastHref = location.href;
  const reportUrl = () => {
    try {
      if (location.href !== lastHref) {
        lastHref = location.href;
        send({ t9: 'url', url: lastHref });
      }
    } catch (e) {
      /* about:blank or a document being torn down */
    }
  };
  for (const name of ['pushState', 'replaceState']) {
    try {
      const original = history[name];
      if (typeof original !== 'function') continue;
      history[name] = function (...args) {
        const result = original.apply(this, args);
        reportUrl();
        return result;
      };
    } catch (e) {
      /* a page froze history; its real navigations still work */
    }
  }
  window.addEventListener('popstate', reportUrl, true);
  window.addEventListener('hashchange', reportUrl, true);

  /* ── YouTube in-stream ads ───────────────────────────────────────────
   * uBlock Origin Lite strips YouTube's ad placement data with its own
   * scriptlet, but only with host access. When the extension is in Basic
   * mode, or off after the environment fallback, the player still receives
   * `adPlacements` / `playerAds` and plays the ad. This is the same fix
   * uBO uses: prune those keys from the player response before YouTube's
   * code reads them. An ad-free response is a normal response - nothing
   * else in the JSON changes.
   */
  if (/(^|\.)youtube\.com$/.test(location.hostname)) {
    const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
    const pruneAds = (data, depth) => {
      if (!data || typeof data !== 'object' || depth > 3) return data;
      for (const key of AD_KEYS) {
        if (key in data) {
          try {
            delete data[key];
          } catch (e) {
            /* frozen object: the page wins, ads stay */
          }
        }
      }
      if (data.playerResponse && typeof data.playerResponse === 'object') {
        pruneAds(data.playerResponse, depth + 1);
      }
      return data;
    };
    try {
      const parse = JSON.parse;
      JSON.parse = function (text, reviver) {
        const parsed = parse.call(this, text, reviver);
        try {
          return pruneAds(parsed, 0);
        } catch (e) {
          return parsed;
        }
      };
    } catch (e) {
      /* a page that locked JSON.parse: ads stay, everything else works */
    }
  }

  /* ── new-window links ──────────────────────────────────────────────── */

  const base = () => document.baseURI || location.href;

  function absolute(url) {
    try {
      return new URL(url, base()).href;
    } catch (e) {
      return null;
    }
  }

  function openInTab(url) {
    const href = absolute(url);
    if (!href || !/^https?:/i.test(href)) return false;
    send({ t9: 'open', url: href });
    return true;
  }

  /* `window.open()` — the plain form. */
  const realOpen = window.open;
  window.open = function (url, name, features) {
    if (url === undefined || url === null || url === '' || String(url) === 'about:blank') {
      // The "open a blank window, then assign its location" pattern (OAuth
      // flows and old download buttons). Hand back a stub: assigning the
      // location is what actually opens the tab.
      const locationStub = {
        assign: (u) => openInTab(u),
        replace: (u) => openInTab(u),
        reload() {},
        toString: () => 'about:blank'
      };
      Object.defineProperty(locationStub, 'href', {
        get: () => 'about:blank',
        set: (u) => openInTab(u)
      });
      const documentStub = {
        write() {},
        writeln() {},
        open() {
          return documentStub;
        },
        close() {}
      };
      const stub = {
        closed: false,
        focus() {},
        blur() {},
        close() {},
        postMessage() {},
        document: documentStub
      };
      Object.defineProperty(stub, 'location', {
        configurable: true,
        get: () => locationStub,
        set: (u) => openInTab(u)
      });
      Object.defineProperty(stub, 'opener', { get: () => window });
      return stub;
    }
    openInTab(url);
    // A denied popup already returns null in a real browser; sites guard for it.
    return null;
  };
  try {
    Object.defineProperty(window.open, 'name', { value: 'open' });
  } catch (e) {
    /* cosmetic only */
  }

  function anchorOf(node) {
    for (let el = node; el && el.nodeType === 1; el = el.parentElement) {
      if (el.tagName === 'A') return el;
    }
    return null;
  }

  function activate(e) {
    if (e.defaultPrevented || e.button > 1) return;
    const a = anchorOf(e.target);
    if (!a || !a.href) return;
    // A download link belongs to the download hook, not a tab.
    if (a.hasAttribute('download')) return;
    const target = (a.getAttribute('target') || '').toLowerCase();
    const newTab =
      (target && target !== '_self' && target !== '_top' && target !== '_parent') ||
      e.ctrlKey ||
      e.metaKey ||
      e.shiftKey ||
      e.button === 1;
    if (!newTab) return;
    if (openInTab(a.href)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }
  }

  window.addEventListener('click', activate, true);
  window.addEventListener('auxclick', activate, true);

  /* GET forms with a new-window target (a few movie/download sites use them). */
  window.addEventListener(
    'submit',
    (e) => {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      const target = (form.getAttribute('target') || '').toLowerCase();
      if (!target || target === '_self' || target === '_top' || target === '_parent') return;
      if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') return;
      try {
        const url = new URL(form.getAttribute('action') || location.href, base());
        url.search = new URLSearchParams(new FormData(form)).toString();
        if (openInTab(url.href)) {
          e.preventDefault();
          e.stopPropagation();
        }
      } catch (err) {
        /* malformed form: let the browser have it */
      }
    },
    true
  );

  /* ── keyboard: the same bindings as src/lib/browser-keys.ts ────────── */

  function grab(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function hit(e, action, value) {
    grab(e);
    send({ t9: 'key', action, value: typeof value === 'number' ? value : null });
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.metaKey) return; // Windows key chords belong to the OS
      const key = e.key;
      const lower = key.length === 1 ? key.toLowerCase() : key;

      /* Alt+… */
      if (e.altKey) {
        if (e.ctrlKey) return;
        if (key === 'ArrowLeft') return hit(e, 'back');
        if (key === 'ArrowRight') return hit(e, 'forward');
        if (key === 'Home') return hit(e, 'goHome');
        if (lower === 'd') return hit(e, 'focusUrlbar');
        return;
      }

      /* No Ctrl: F5 / Esc / F1 only. Backspace is deliberately not "back":
         it would break every text field on every site. */
      if (!e.ctrlKey) {
        if (key === 'F5') return hit(e, 'reload', 0);
        if (key === 'Escape') return hit(e, 'stopLoading');
        if (key === 'F1') return hit(e, 'openHelp');
        return;
      }

      /* Ctrl+Shift+… */
      if (e.shiftKey) {
        if (key === 'Tab') return hit(e, 'prevTab');
        if (key === 'PageUp') return hit(e, 'moveTab', -1);
        if (key === 'PageDown') return hit(e, 'moveTab', 1);
        if (key === 'F3') return hit(e, 'findInPage');
        if (key === 'F4') return hit(e, 'closeTab');
        if (key === 'F5') return hit(e, 'reload', 1);
        if (key === 'Delete') return hit(e, 'clearHistory');
        if (lower === 't') return hit(e, 'reopenClosedTab');
        if (lower === 'w') return hit(e, 'closeBrowserView');
        if (lower === 'r') return hit(e, 'reload', 1);
        if (lower === 'd') return hit(e, 'bookmarkAllTabs');
        if (lower === 'o') return hit(e, 'openBookmarks');
        if (lower === 'f' || lower === 'g') return hit(e, 'findInPage');
        return;
      }

      /* Ctrl+… */
      if (key === 'Tab') return hit(e, 'nextTab');
      if (key === 'PageDown') return hit(e, 'nextTab');
      if (key === 'PageUp') return hit(e, 'prevTab');
      if (key === 'F3') return hit(e, 'findInPage');
      if (key === 'F4') return hit(e, 'closeTab');
      if (key === 'F5') return hit(e, 'reload', 1);

      switch (lower) {
        case 't':
        case 'n':
          return hit(e, 'newTab');
        case 'w':
          return hit(e, 'closeTab');
        case 'r':
          return hit(e, 'reload', 0);
        case 'l':
        case 'k':
          return hit(e, 'focusUrlbar');
        case 'j':
          return hit(e, 'downloads');
        case 'h':
          return hit(e, 'history');
        case 'd':
          return hit(e, 'bookmark');
        case 'b':
          return hit(e, 'openBookmarks');
        case 's':
          return hit(e, 'savePage');
        case 'o':
          return hit(e, 'openFile');
        case 'p':
          return hit(e, 'printPage');
        case 'u':
          return hit(e, 'viewSource');
        case 'f':
          return hit(e, 'findInPage');
        default:
          break;
      }

      if (key === '+' || key === '=') return hit(e, 'zoom', 1);
      if (key === '-' || key === '_') return hit(e, 'zoom', -1);
      if (key === '0') return hit(e, 'zoom', 0);
      if (/^[1-8]$/.test(key)) return hit(e, 'selectTabN', Number(key) - 1);
      if (key === '9') return hit(e, 'lastTab');
    },
    true
  );
})();
