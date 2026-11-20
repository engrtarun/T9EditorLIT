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

  /* ── fullscreen ──────────────────────────────────────────────────────
   * A page's ⛶ only fills the webview. Rust grows that webview to the whole
   * window (and puts it back afterwards), so YouTube's fullscreen is a real
   * fullscreen instead of a letterboxed video inside the content rect.
   */
  const reportFullscreen = () => {
    let on = 0;
    try {
      on = document.fullscreenElement ? 1 : 0;
    } catch (e) {
      return;
    }
    send({ t9: 'fullscreen', value: on });
  };
  document.addEventListener('fullscreenchange', reportFullscreen, true);

  /* ── media state for the Windows flyout (SMTC) ───────────────────────
   * The app owns the only media session (Chromium's own is switched off in
   * `browser.rs`), so this report is what puts the video's title on the
   * flyout and what gives an earbud press one owner. The page's own
   * `navigator.mediaSession` handlers are captured here too: "next" means
   * the page's playlist next, not "seek the <video> somewhere".
   */
  const mediaSession = (() => {
    try {
      return navigator.mediaSession || null;
    } catch (e) {
      return null;
    }
  })();
  const mediaHandlers = Object.create(null);
  if (mediaSession) {
    try {
      const setActionHandler = mediaSession.setActionHandler;
      if (typeof setActionHandler === 'function') {
        mediaSession.setActionHandler = function (action, handler) {
          if (handler) mediaHandlers[action] = handler;
          else delete mediaHandlers[action];
          try {
            return setActionHandler.call(mediaSession, action, handler);
          } catch (e) {
            // Chromium's session is off; the page's call must not throw.
            return undefined;
          }
        };
      }
    } catch (e) {
      /* frozen MediaSession: next/prev fall back to the element */
    }
  }

  const mediaElement = () => {
    try {
      return document.querySelector('video') || document.querySelector('audio');
    } catch (e) {
      return null;
    }
  };

  let mediaTimer = 0;
  let mediaSentAt = 0;
  let mediaKey = '';
  /** The element that has actually played at least once. */
  let playedEl = null;

  const httpUrl = (raw) => {
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch (e) {
      return '';
    }
  };

  const pageTitle = () => {
    let title = '';
    try {
      const og = document.querySelector('meta[property="og:title"]');
      title = (og && og.content) || document.title || '';
    } catch (e) {
      title = '';
    }
    // YouTube appends " - YouTube" to document.title; the card already shows
    // the app name, so that suffix is noise, not part of the video title.
    return title.replace(/\s*[-\u2013\u2014]\s*YouTube\s*$/i, '').trim();
  };

  const channelName = () => {
    // YouTube keeps the channel next to the title. MediaSession metadata
    // often has no `artist`, and the hostname ("youtube.com") is a terrible
    // stand-in for the channel the user is actually watching.
    const selectors = [
      'ytd-watch-metadata ytd-channel-name a',
      '#owner #channel-name a',
      'ytd-video-owner-renderer ytd-channel-name a'
    ];
    for (const selector of selectors) {
      try {
        const node = document.querySelector(selector);
        const name = node && (node.textContent || '').trim();
        if (name) return name;
      } catch (e) {
        /* layout changed: try the next one */
      }
    }
    return '';
  };

  const artworkOf = (metadata) => {
    try {
      const list = metadata && metadata.artwork ? metadata.artwork : [];
      // The largest entry is last in every player seen so far (YouTube,
      // Spotify). Only absolute http(s) survives: Windows fetches the image
      // out-of-process, so a blob:/data: URL is a guaranteed blank card.
      for (let i = list.length - 1; i >= 0; i--) {
        const src = httpUrl(list[i] && list[i].src);
        if (src) return src;
      }
    } catch (e) {
      /* unusable artwork list */
    }
    try {
      const og = document.querySelector('meta[property="og:image"]');
      const src = httpUrl(og && og.content);
      if (src) return src;
    } catch (e) {
      /* no og:image */
    }
    try {
      return httpUrl(mediaElement() && mediaElement().poster);
    } catch (e) {
      return '';
    }
  };

  const reportMedia = () => {
    mediaTimer = 0;
    const el = mediaElement();
    const metadata = (() => {
      try {
        return mediaSession && mediaSession.metadata;
      } catch (e) {
        return null;
      }
    })();
    const duration = el && isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    const position = el && isFinite(el.currentTime) ? el.currentTime : 0;
    const playing = !!el && !el.paused && !el.ended;
    const title = ((metadata && metadata.title) || pageTitle()).trim();
    // A preloaded / hover-preview <video> is paused at 0:00 with no metadata.
    // That is *not* playback: until this element (or one like it) has really
    // played, the report is `none` and no Windows card exists.
    const everPlayed = !!el && (playedEl === el || !el.paused || position > 0.05);
    // Muted hover previews on YouTube's home page have no metadata; they are
    // decoration, not media the user asked for.
    const decoration = !!el && el.muted && !(metadata && (metadata.title || metadata.artist));
    const state =
      !el || !everPlayed || decoration || !title ? 'none' : playing ? 'playing' : 'paused';
    const host = location.hostname.replace(/^www\./, '');
    const artist = (
      (metadata && (metadata.artist || metadata.album)) ||
      channelName() ||
      host
    ).trim();
    const artwork = artworkOf(metadata);
    // The page's handlers are the real thing; YouTube's own next/previous
    // buttons are the fallback so the flyout arrows are never dead on a
    // watch page that skipped MediaSession registration.
    const next = !!mediaHandlers.nexttrack || !!document.querySelector('.ytp-next-button');
    const prev = !!mediaHandlers.previoustrack || !!document.querySelector('.ytp-prev-button');
    // Position-only heartbeats: the key ignores position/time, so a moving
    // timeline never repaints the flyout's metadata.
    const key = [state, title, artist, artwork, next, prev].join('|');
    const now = Date.now();
    if (key === mediaKey && now - mediaSentAt < 1400) {
      if (state === 'playing') mediaTimer = setTimeout(reportMedia, 300);
      return;
    }
    mediaKey = key;
    mediaSentAt = now;
    send({
      t9: 'media',
      state,
      title: state === 'none' ? '' : title,
      artist: state === 'none' ? '' : artist,
      album: host,
      artwork: state === 'none' ? '' : artwork,
      position,
      duration,
      rate: el && isFinite(el.playbackRate) ? el.playbackRate : 1,
      next,
      prev
    });
    if (state === 'playing') {
      // Some players only use requestVideoFrameCallback; this keeps the
      // flyout's position moving without depending on timeupdate.
      mediaTimer = setTimeout(reportMedia, 1600);
    }
  };

  const scheduleMedia = () => {
    if (mediaTimer) return;
    mediaTimer = setTimeout(reportMedia, 300);
  };

  const rememberPlayback = (event) => {
    const el = event && event.target;
    if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) playedEl = el;
    scheduleMedia();
  };

  for (const name of [
    'play',
    'playing',
    'pause',
    'ended',
    'seeked',
    'loadedmetadata',
    'durationchange',
    'ratechange',
    'emptied',
    'canplay'
  ]) {
    document.addEventListener(name, rememberPlayback, true);
  }
  // `timeupdate` fires ~4×/s. Reporting four times a second is pure overhead;
  // this keeps the timeline honest at ~1.5 s while the page is playing.
  document.addEventListener(
    'timeupdate',
    () => {
      if (Date.now() - mediaSentAt > 1500) scheduleMedia();
    },
    true
  );
  document.addEventListener('DOMContentLoaded', scheduleMedia, true);
  window.addEventListener('load', scheduleMedia, true);

  // MediaSession metadata is usually assigned *after* playback starts (and
  // again when an ad ends). Watching the assignment is what makes the title
  // and the thumbnail appear without waiting for an unrelated DOM event.
  if (mediaSession) {
    try {
      const proto = Object.getPrototypeOf(mediaSession);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'metadata');
      if (descriptor && descriptor.configurable) {
        Object.defineProperty(mediaSession, 'metadata', {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() {
            return descriptor.get ? descriptor.get.call(this) : undefined;
          },
          set(value) {
            if (descriptor.set) descriptor.set.call(this, value);
            scheduleMedia();
            // Some players assign twice in one tick (placeholder, then real).
            setTimeout(scheduleMedia, 800);
            setTimeout(scheduleMedia, 2400);
          }
        });
      }
    } catch (e) {
      /* frozen MediaSession: heartbeats still pick the metadata up */
    }
  }

  const runMediaAction = (name, details, fallback) => {
    const handler = mediaHandlers[name];
    if (typeof handler === 'function') {
      try {
        handler(details);
        return;
      } catch (e) {
        /* fall through to the element */
      }
    }
    try {
      fallback();
    } catch (e) {
      /* nothing here to control */
    }
  };

  // Called by Rust when the flyout, a media key or an earbud button fires.
  window.__t9MediaAction = (action, value) => {
    const el = mediaElement();
    switch (action) {
      case 'play':
        return runMediaAction(
          'play',
          { action: 'play' },
          () => el && el.play && el.play().catch(() => {})
        );
      case 'pause':
        return runMediaAction('pause', { action: 'pause' }, () => el && el.pause());
      case 'next':
        return runMediaAction('nexttrack', { action: 'nexttrack' }, () => {
          const button = document.querySelector('.ytp-next-button');
          if (button) button.click();
        });
      case 'prev':
        return runMediaAction('previoustrack', { action: 'previoustrack' }, () => {
          const button = document.querySelector('.ytp-prev-button');
          if (button) button.click();
        });
      case 'stop':
        return runMediaAction('stop', { action: 'stop' }, () => {
          if (el) {
            el.pause();
            el.currentTime = 0;
          }
        });
      case 'forward':
        return runMediaAction('seekforward', { action: 'seekforward', seekOffset: 10 }, () => {
          if (el) el.currentTime = Math.min(el.duration || 1e9, el.currentTime + 10);
          scheduleMedia();
        });
      case 'rewind':
        return runMediaAction('seekbackward', { action: 'seekbackward', seekOffset: 10 }, () => {
          if (el) el.currentTime = Math.max(0, el.currentTime - 10);
          scheduleMedia();
        });
      case 'seek':
        if (!isFinite(value)) return;
        return runMediaAction('seekto', { action: 'seekto', seekTime: Number(value) }, () => {
          if (el) el.currentTime = Number(value);
          scheduleMedia();
        });
      default:
        return;
    }
  };

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

  /*
   * Kept in table form on purpose: `browser-keys.test.ts` parses these rows
   * and fails when they drift from BINDINGS, so the page webview and the
   * address bar can never disagree about a shortcut. Columns:
   *
   *   combo | action | value | whileTyping
   *
   * `whileTyping` is Firefox's rule: tab management, reload, downloads and
   * save still work while the focus sits in an <input>, <textarea> or
   * contenteditable. Every other row belongs to the page in that moment
   * (Ctrl+C, Ctrl+V, Ctrl+A, Ctrl+Z, Ctrl+B for bold, …).
   */
  const KEYS = [
    ['ctrl+t', 'newTab', 0, true],
    ['ctrl+shift+b', 'newTab', 0, true],
    ['ctrl+w', 'closeTab', 0, true],
    ['ctrl+f4', 'closeTab', 0, true],
    ['ctrl+n', 'newTab', 0, true],
    ['ctrl+shift+t', 'reopenClosedTab', 0, true],
    ['ctrl+shift+tab', 'prevTab', 0, true],
    ['ctrl+pageup', 'prevTab', 0, true],
    ['ctrl+tab', 'nextTab', 0, true],
    ['ctrl+pagedown', 'nextTab', 0, true],
    ['ctrl+1', 'selectTabN', 0, true],
    ['ctrl+2', 'selectTabN', 1, true],
    ['ctrl+3', 'selectTabN', 2, true],
    ['ctrl+4', 'selectTabN', 3, true],
    ['ctrl+5', 'selectTabN', 4, true],
    ['ctrl+6', 'selectTabN', 5, true],
    ['ctrl+7', 'selectTabN', 6, true],
    ['ctrl+8', 'selectTabN', 7, true],
    ['ctrl+9', 'lastTab', 0, true],
    ['ctrl+shift+pageup', 'moveTab', -1, true],
    ['ctrl+shift+pagedown', 'moveTab', 1, true],
    ['ctrl+shift+p', 'pinTab', 0, true],
    ['ctrl+shift+w', 'closeBrowserView', 0, true],
    ['alt+arrowleft', 'back', 0, false],
    ['backspace', 'back', 0, false],
    ['alt+arrowright', 'forward', 0, false],
    ['shift+backspace', 'forward', 0, false],
    ['f5', 'reload', 0, true],
    ['ctrl+r', 'reload', 0, true],
    ['ctrl+f5', 'reload', 1, true],
    ['ctrl+shift+r', 'reload', 1, true],
    ['escape', 'stopLoading', 0, false],
    ['alt+home', 'goHome', 0, false],
    ['ctrl+l', 'focusUrlbar', 0, true],
    ['alt+d', 'focusUrlbar', 0, true],
    ['f6', 'focusUrlbar', 0, true],
    ['ctrl+j', 'downloads', 0, true],
    ['ctrl+h', 'history', 0, false],
    ['ctrl+shift+delete', 'clearHistory', 0, false],
    ['ctrl+d', 'bookmark', 0, false],
    ['ctrl+shift+d', 'bookmarkAllTabs', 0, false],
    ['ctrl+b', 'openBookmarks', 0, false],
    ['ctrl+shift+o', 'openBookmarks', 0, false],
    ['ctrl+s', 'savePage', 0, true],
    ['ctrl+o', 'openFile', 0, true],
    ['ctrl+p', 'printPage', 0, false],
    ['ctrl+u', 'viewSource', 0, false],
    ['ctrl+f', 'findInPage', 0, false],
    ['f3', 'findInPage', 0, false],
    ['shift+f3', 'findInPage', 0, false],
    ['ctrl+shift+g', 'findInPage', 0, false],
    ['ctrl+shift+f', 'findInPage', 0, false],
    ['ctrl+=', 'zoom', 1, false],
    ['ctrl+shift+=', 'zoom', 1, false],
    ['ctrl++', 'zoom', 1, false],
    ['ctrl+-', 'zoom', -1, false],
    ['ctrl+0', 'zoom', 0, false],
    ['f11', 'toggleFullscreen', 0, true],
    ['f1', 'openHelp', 0, true]
  ];

  function grab(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  function typingInPage(e) {
    const path = e.composedPath ? e.composedPath() : null;
    const target = (path && path[0]) || e.target;
    if (!target || target.nodeType !== 1) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable === true;
  }

  function comboHit(e, combo) {
    // `ctrl++` is the "+" key: a plain split would leave an empty last part.
    const plus = combo.slice(-2) === '++';
    const parts = (plus ? combo.slice(0, -2) : combo).split('+');
    const key = plus ? '+' : parts.pop();
    if (e.ctrlKey !== parts.includes('ctrl')) return false;
    if (e.altKey !== parts.includes('alt')) return false;
    // "+" is Shift+= on most layouts, but the numpad sends "+" without it,
    // so Shift is not part of that row.
    if (!plus && e.shiftKey !== parts.includes('shift')) return false;
    return e.key.toLowerCase() === key;
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.metaKey) return; // Windows key chords belong to the OS
      // Fullscreen: Escape belongs to the page (YouTube's exit), not to the
      // browser's stop-loading. Grabbing it here trapped the user in a
      // fullscreen video with no way out except the ⛶ button.
      if (e.key === 'Escape' && document.fullscreenElement) return;

      const typing = typingInPage(e);
      for (let i = 0; i < KEYS.length; i++) {
        const row = KEYS[i];
        if (typing && !row[3]) continue;
        if (!comboHit(e, row[0])) continue;
        grab(e);
        send({ t9: 'key', action: row[1], value: row[2] });
        return;
      }
    },
    true
  );

  /* ── two-finger horizontal swipe → prev/next tab (Firefox's gesture) ────
   * "firefox ki tarah 2unglis se left right se previous or next tab me jaya
   * ja sake". This document-start shim is the ONLY place the wheel over page
   * content can be heard: the page is a native child HWND, so the shell's
   * own listener (BrowserView) never sees it. The gesture is accumulated
   * exactly like src/lib/browser-swipe.ts — horizontal-dominant events add
   * up, any vertical scroll cancels, ±120 px fires once, then a 300 ms
   * cooldown swallows the momentum. Mirrored rather than imported: this file
   * is a standalone script compiled into the binary. Report through the key
   * bridge so the existing `browser:key` → runBrowserAction path (with its
   * "browser view must be open" gate) does the rest.
   */
  let swipePx = 0;
  let swipeUntil = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) return; // pinch-zoom is Chromium's own gesture
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
      } else if (e.deltaMode === 2) {
        dx *= window.innerWidth;
        dy *= window.innerHeight;
      }
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= 4) {
        const now = Date.now();
        if (now < swipeUntil) return; // one swipe, one switch
        // A page that scrolls sideways owns its horizontal wheel — a
        // carousel or a wide table must keep its own scrolling.
        const root = document.scrollingElement || document.documentElement;
        if (root.scrollWidth > root.clientWidth + 4) {
          swipePx = 0;
          return;
        }
        swipePx += dx;
        if (swipePx <= -120) {
          swipePx = 0;
          swipeUntil = now + 300;
          send({ t9: 'key', action: 'nextTab', value: 0 }); // fingers left
        } else if (swipePx >= 120) {
          swipePx = 0;
          swipeUntil = now + 300;
          send({ t9: 'key', action: 'prevTab', value: 0 }); // fingers right
        }
        return;
      }
      if (dy !== 0) swipePx = 0; // a vertical scroll cancels the gesture
    },
    true
  );

  /* ── uBlock Origin Lite control bridge ────────────────────────────────
   * The T9 control bridge is a content script in the extension's isolated
   * world (see go/internal/ublock/bridge.go). It answers control requests
   * with window.postMessage({ __t9ublock: 1, dir: 'resp', id, ok, response }).
   * Content scripts cannot call chrome.webview, so we — the main-world shim —
   * are the hop from that isolated world to Rust. Requests are injected by
   * Rust with eval(); only the replies travel through here.
   */
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__t9ublock !== 1 || d.dir !== 'resp' || typeof d.id !== 'string') return;
    send({ t9: 'ublock', id: d.id, ok: !!d.ok, response: d.response });
  });
})();
