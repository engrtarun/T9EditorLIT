<script lang="ts">
  /**
   * The browser view — Firefox's window, inside T9.
   *
   * Firefox 157's toolbar shape: the **tab strip sits on top** of the address
   * bar, both on one chrome surface, with round buttons and a pill-shaped
   * address bar. The content area below is an exact rectangle the native child
   * webview is positioned over (`browser_set_rect` gets this element's bounding
   * box). While no page webview exists — new tab, or the dev preview — the area
   * renders the speed dial / an iframe itself.
   *
   * Switching back to the editor unmounts this whole tree (App.svelte's
   * `{#if}`), which is also when the Rust side suspends every tab webview:
   * the zero-RAM rule, applied to browsing.
   */
  import TabStrip from './TabStrip.svelte';
  import UrlBar from './UrlBar.svelte';
  import SpeedDial from './SpeedDial.svelte';
  import DownloadsPanel from './DownloadsPanel.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import BrowserMenu from './BrowserMenu.svelte';
  import NowPlaying from './NowPlaying.svelte';
  import { browser } from '../../stores/browser.svelte';
  import { downloads } from '../../stores/downloads.svelte';
  import { ublock } from '../../stores/ublock.svelte';
  import { app } from '../../stores/app.svelte';
  import { layout } from '../../stores/layout.svelte';
  import { menu } from '../../stores/menu.svelte';
  import {
    isTauri,
    browserViewClosed,
    browserSetRect,
    browserSetVisible,
    onBrowserFullscreen
  } from '../../ipc';
  import { onMount } from 'svelte';

  const tab = $derived(browser.active);

  /** Back / forward ride the store's own history stack. */
  const canBack = $derived(browser.canBack());
  const canForward = $derived(browser.canForward());
  /** Brave/Chrome behaviour: the reload button becomes Stop while loading. */
  const loading = $derived(tab?.loading ?? false);

  // Wire the store to the native side once (browserShow + event listeners).
  // The rect effect below measures this element and keeps the child webview
  // aligned with it.
  let contentEl = $state<HTMLDivElement | null>(null);

  /** A page (YouTube's ⛶) is fullscreen — Rust grew its webview over the chrome. */
  let fullscreen = $state(false);

  onMount(() => {
    browser.wireTauri();
    // Pins from the last session come back as tabs before the first show, so
    // the user is not re-pinning YouTube on every launch. No-op once any tab
    // exists (the browser is already in use).
    browser.restorePinned();
    // A tab may already exist: the tools panel opens a link and *then* switches
    // to this view, so the store created the tab before anything was wired.
    browser.showActive();
    // One poll at mount: the daemon recovers unfinished downloads from their
    // sidecars, and the toolbar badge must show them without opening the panel.
    downloads.boot();
    // uBlock: disk status from the daemon, runtime truth from WebView2. The
    // folder is already unpacked by the time a tab exists; this only reports.
    ublock.boot();
    // Fullscreen: the chrome's rows are covered by the grown webview anyway,
    // so they only need to stop painting (no layout change — a layout change
    // here would feed a new rect back to Rust mid-fullscreen).
    let dead = false;
    let offFullscreen: (() => void) | null = null;
    void onBrowserFullscreen(({ id, on }) => {
      if (browser.activeId !== id) return;
      fullscreen = on;
    })
      .then((off) => {
        if (dead) off();
        else offFullscreen = off;
      })
      .catch(() => {
        /* dev preview: no native event bus */
      });
    return () => {
      dead = true;
      offFullscreen?.();
      fullscreen = false;
      ublock.dispose();
      // The whole browser tree unmounts (App.svelte's {#if}): sweep EVERY
      // tab webview (kept ones included) so the 500 MB budget holds while
      // the editor is open. Nothing page-live survives the view. The Ctrl+H
      // panel starts closed next time, like Firefox's own history sidebar.
      browser.historyOpen = false;
      void browserViewClosed();
    };
  });

  // Last tab closed (Ctrl+W or the ✕): there is nothing left to browse —
  // the browser closes and the screen that opened it comes back. The
  // `hadTabs` guard stops the effect from closing a browser that was
  // opened onto the speed dial with zero tabs.
  let hadTabs = false;
  $effect(() => {
    if (browser.tabs.length > 0) {
      hadTabs = true;
    } else if (hadTabs) {
      app.closeBrowser();
    }
  });

  // Keep the native webview's rect aligned with the content area. The
  // effect re-runs whenever the container's box changes (tab strip grows,
  // downloads panel opens, window resizes) because the ResizeObserver
  // writes into the `rect` signal.
  let rect = $state({ x: 0, y: 0, width: 0, height: 0 });
  // Debounce: the ResizeObserver fires on every sub-pixel change during a
  // CSS transition (menu / panel open). Each call is an IPC round trip that
  // marshals onto the main thread, and a flood of them is what made the
  // browser feel frozen ("buttons not responding") while a panel animated.
  let rectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The last rectangle actually sent. The ResizeObserver also fires for
   * sub-pixel changes that round to the same box; every duplicate was a full
   * IPC trip onto the main thread (the diag log showed dozens a minute for a
   * page that had not moved at all). Whole pixels only — the native side
   * positions whole pixels.
   */
  let lastSent = { x: -1, y: -1, width: -1, height: -1 };

  function applyRect(r: { x: number; y: number; width: number; height: number }) {
    if (r.width <= 0 || r.height <= 0) return;
    const next = {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      // -1 safety margin so the native webview can never paint over the
      // panel header sitting immediately below the content box.
      height: Math.max(1, Math.round(r.height) - 1)
    };
    if (
      next.x === lastSent.x &&
      next.y === lastSent.y &&
      next.width === lastSent.width &&
      next.height === lastSent.height
    ) {
      return;
    }
    lastSent = next;
    void browserSetRect(next.x, next.y, next.width, next.height);
  }

  function pushRect(r: { x: number; y: number; width: number; height: number }) {
    if (rectTimer) clearTimeout(rectTimer);
    rectTimer = setTimeout(() => applyRect(r), 30);
  }
  $effect(() => {
    const el = contentEl;
    if (!el || !isTauri()) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      rect = { x: r.left, y: r.top, width: r.width, height: r.height };
      pushRect(rect);
    });
    ro.observe(el);
    // Seed the first measurement immediately (RO fires async).
    const r = el.getBoundingClientRect();
    rect = { x: r.left, y: r.top, width: r.width, height: r.height };
    pushRect(rect);
    return () => {
      if (rectTimer) clearTimeout(rectTimer);
      ro.disconnect();
    };
  });

  // When the downloads panel toggles, re-measure right away — the native
  // webview must never sit over the panel's header buttons, even for a
  // frame. (The RO above catches it too, but this is synchronous.)
  $effect(() => {
    downloads.open;
    const el = contentEl;
    if (!el || !isTauri()) return;
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      applyRect({ x: r.left, y: r.top, width: r.width, height: r.height });
    });
  });

  // Every DOM overlay that can cross the content rect — the 9-dots tools
  // panel, the top bar's profile popover, the settings / help dialogs, a
  // right-click menu — is painted *under* a native child webview, so its
  // lower half used to disappear behind the page. Park the page while any of
  // them is open; audio and page state survive because nothing is closed.
  $effect(() => {
    const open =
      layout.toolsOpen ||
      layout.profileOpen ||
      layout.settingsOpen ||
      layout.helpOpen ||
      !!menu.current;
    if (!isTauri()) return;
    void browserSetVisible(!open);
  });
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col bg-nc-bg text-nc-txt">
  <!-- ── chrome: tabs on top, address bar under, one surface ────────────── -->
  <div class="shrink-0 border-b border-nc-line bg-nc-panel" class:invisible={fullscreen}>
    <TabStrip />

    <div class="flex h-10 items-center gap-0.5 px-2 pb-1.5">
      <button
        type="button"
        disabled={!canBack}
        onclick={() => browser.back()}
        class="grid h-8 w-8 place-items-center rounded-full text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-35 disabled:hover:bg-transparent"
        title="Back"
        aria-label="Go back"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
        >
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </button>
      <button
        type="button"
        disabled={!canForward}
        onclick={() => browser.forward()}
        class="grid h-8 w-8 place-items-center rounded-full text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-35 disabled:hover:bg-transparent"
        title="Forward"
        aria-label="Go forward"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
        >
          <path d="M9 5l7 7-7 7" />
        </svg>
      </button>
      <button
        type="button"
        onclick={() => (loading ? browser.stopLoading() : browser.reload())}
        class="relative grid h-8 w-8 place-items-center rounded-full transition-colors hover:bg-nc-panel-2
               {loading ? 'text-nc-brand' : 'text-nc-mut hover:text-nc-txt'}"
        title={loading ? 'Stop loading (Esc)' : 'Reload (Ctrl+R)'}
        aria-label={loading ? 'Stop loading' : 'Reload page'}
      >
        {#if loading}
          <!-- Brave/Chrome: refresh turns into a stop while the page loads. -->
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.1"
            stroke-linecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        {:else}
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
          >
            <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" />
          </svg>
        {/if}
      </button>

      <div class="mx-1 min-w-0 flex-1">
        <UrlBar />
      </div>

      <!-- downloads: opens the panel, shows the running count -->
      <button
        type="button"
        onclick={() => downloads.toggle()}
        class="relative grid h-8 w-8 place-items-center rounded-full text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt"
        title="Downloads"
        aria-label="Show downloads"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
        </svg>
        {#if downloads.activeCount > 0}
          <span
            class="absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-nc-brand px-0.5 text-[9px] leading-none font-bold text-white"
          >
            {downloads.activeCount}
          </span>
        {/if}
      </button>

      <!--
        The Firefox hamburger. Everything that is not an everyday control
        lives here: downloads, history, bookmarks, speed dial, page source,
        the fast download, shortcuts, zoom, uBlock and downloader settings.
        It is a layout sheet, not a popover — the page is a native child
        webview and would paint above any floating menu.
      -->
      <button
        type="button"
        onclick={() => browser.toggleSettings()}
        class="grid h-8 w-8 place-items-center rounded-full transition-colors
               {browser.settingsOpen
          ? 'bg-nc-panel-2 text-nc-brand'
          : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
        title="Menu (settings, bookmarks, downloads)"
        aria-label="Open browser menu"
        aria-expanded={browser.settingsOpen}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
    </div>
  </div>

  <!-- ── the menu sheet (takes layout space, never floats over the page) ── -->
  <BrowserMenu />

  <!-- Page-load pulse: Brave's own cue that something is happening, even
       when the page itself is still the old frame. 2px, never a layout jump. -->
  <div
    class="relative shrink-0 overflow-hidden transition-[height] duration-150 {loading
      ? 'h-0.5'
      : 'h-0'}"
    aria-hidden="true"
  >
    {#if loading}
      <div class="t9-loadbar text-nc-brand"></div>
    {/if}
  </div>

  <!-- Now playing: the controllable timeline Windows' flyout cannot show.
       Rendered *outside* the measured content rect, so the native page starts
       below it instead of painting over it. Hidden (not unmounted) while a
       page is fullscreen, keeping the rect stable there. -->
  <NowPlaying hidden={fullscreen} />

  <!-- ── content: the exact rect the native webview covers ───────────── -->
  <div bind:this={contentEl} class="relative min-h-0 flex-1" data-focus="browser-content">
    {#if !tab || tab.url === 'about:blank'}
      <SpeedDial />
    {:else if !isTauri()}
      <!--
        Dev preview only: an iframe stands in for the native webview so the
        chrome can be styled against real pages. Most sites refuse framing
        (X-Frame-Options) — that is a preview limitation, not a bug.
      -->
      <iframe
        src={tab.url}
        title={tab.title}
        class="h-full w-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms"
      ></iframe>
    {:else}
      <!--
        Desktop: the Rust side positions `tab-{id}` over this box. This
        text is only honest while the page is actually loading — a live
        webview covers the whole box the moment it is positioned, and a
        finished page that stays "loading" was exactly the invisible-webview
        bug (rect measured as 0×0), so the lie had to go too.
      -->
      <div class="grid h-full w-full place-items-center bg-nc-bg">
        {#if tab.loading}
          <div class="flex flex-col items-center gap-3">
            <span
              class="h-8 w-8 animate-spin rounded-full border-2 border-nc-line border-t-nc-brand"
              aria-hidden="true"
            ></span>
            <p class="text-[13px] text-nc-mut">{tab.title} khul raha hai…</p>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- ── downloads ───────────────────────────────────────────────────── -->
  <DownloadsPanel />
  <!-- ── history (Ctrl + H) ─────────────────────────────────────────── -->
  <HistoryPanel />
</div>

<style>
  /* Indeterminate, because WebView2 does not expose byte progress. It is
     honest about direction (left → right) without inventing a percentage. */
  .t9-loadbar {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      currentcolor 30%,
      currentcolor 70%,
      transparent 100%
    );
    animation: t9-load-slide 1.1s ease-in-out infinite;
  }

  @keyframes t9-load-slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(100%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .t9-loadbar {
      animation-duration: 2.6s;
    }
  }
</style>
