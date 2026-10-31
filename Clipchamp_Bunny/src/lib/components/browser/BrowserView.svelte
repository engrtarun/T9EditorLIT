<script lang="ts">
  /**
   * The browser view — Firefox's window, inside T9.
   *
   * Layout: toolbar (back · forward · reload · address bar · downloads ·
   * close) → tab strip → content → downloads panel. The content area is an
   * exact rectangle the native child webview is positioned over (Slice 3:
   * `browser_set_rect` gets this element's bounding box). While no page
   * webview exists — new tab, or the dev preview — the area renders the
   * speed dial / an iframe itself.
   *
   * Switching back to the editor unmounts this whole tree (App.svelte's
   * `{#if}`), which is also when the Rust side suspends every tab webview:
   * the zero-RAM rule, applied to browsing.
   */
  import TabStrip from './TabStrip.svelte';
  import UrlBar from './UrlBar.svelte';
  import SpeedDial from './SpeedDial.svelte';
  import DownloadsPanel from './DownloadsPanel.svelte';
  import { browser } from '../../stores/browser.svelte';
  import { downloads } from '../../stores/downloads.svelte';
  import { app } from '../../stores/app.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { isTauri, browserViewClosed, browserSetRect } from '../../ipc';
  import { onMount } from 'svelte';

  const tab = $derived(browser.active);

  /** Back / forward ride the store's own history stack. */
  const canBack = $derived(browser.canBack());
  const canForward = $derived(browser.canForward());

  // Wire the store to the native side once (browserShow + event listeners).
  // The rect effect below measures this element and keeps the child webview
  // aligned with it.
  let contentEl = $state<HTMLDivElement | null>(null);

  onMount(() => {
    browser.wireTauri();
    return () => {
      // The whole browser tree unmounts (App.svelte's {#if}): sweep EVERY
      // tab webview (kept ones included) so the 500 MB budget holds while
      // the editor is open. Nothing page-live survives the view.
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
  $effect(() => {
    const el = contentEl;
    if (!el || !isTauri()) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      rect = { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    ro.observe(el);
    // Seed the first measurement immediately (RO fires async).
    const r = el.getBoundingClientRect();
    rect = { x: r.left, y: r.top, width: r.width, height: r.height };
    return () => ro.disconnect();
  });

  $effect(() => {
    if (rect.width > 0 && rect.height > 0) {
      void browserSetRect(rect.x, rect.y, rect.width, rect.height);
    }
  });

  /** ⬇ in the toolbar: hand the active tab's URL to the fast downloader. */
  async function downloadPage() {
    if (!tab || tab.url === 'about:blank') return;
    try {
      await downloads.start(tab.url, { referer: tab.url });
      toast.push('info', '⬇ Download shuru — multi-segment speed me');
    } catch (err) {
      toast.push('warn', err instanceof Error ? err.message : 'Download start nahi hua');
    }
  }
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col bg-nc-bg text-nc-txt">
  <!-- ── toolbar ─────────────────────────────────────────────────────── -->
  <div class="flex h-9 shrink-0 items-center gap-1 border-b border-nc-line bg-nc-panel px-1.5">
    <button
      type="button"
      disabled={!canBack}
      onclick={() => browser.back()}
      class="grid h-7 w-7 place-items-center rounded-md text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-35 disabled:hover:bg-transparent"
      title="Back"
      aria-label="Go back"
    >
      <svg
        width="14"
        height="14"
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
      class="grid h-7 w-7 place-items-center rounded-md text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-35 disabled:hover:bg-transparent"
      title="Forward"
      aria-label="Go forward"
    >
      <svg
        width="14"
        height="14"
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
      onclick={() => browser.reload()}
      class="grid h-7 w-7 place-items-center rounded-md text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt"
      title="Reload"
      aria-label="Reload page"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
      >
        <path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" />
      </svg>
    </button>

    <UrlBar ondownload={downloadPage} />

    <!-- downloads: opens the panel, shows the running count -->
    <button
      type="button"
      onclick={() => downloads.toggle()}
      class="relative grid h-7 w-7 place-items-center rounded-md text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt"
      title="Downloads"
      aria-label="Show downloads"
    >
      <svg
        width="14"
        height="14"
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

    <!-- close the browser → back to the screen that opened it -->
    <button
      type="button"
      onclick={() => app.closeBrowser()}
      class="grid h-7 w-7 place-items-center rounded-md text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt"
      title="Browser band karo (editor pe wapas)"
      aria-label="Close browser"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <path d="M2 2l8 8M10 2l-8 8" />
      </svg>
    </button>
  </div>

  <!-- ── tab strip ───────────────────────────────────────────────────── -->
  <TabStrip />

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
          <p class="animate-pulse text-[13px] text-nc-mut">{tab.title} khul raha hai…</p>
        {/if}
      </div>
    {/if}
  </div>

  <!-- ── downloads ───────────────────────────────────────────────────── -->
  <DownloadsPanel />
</div>
