<script lang="ts">
  /**
   * Firefox's hamburger, rebuilt for T9's browser.
   *
   * It is a sheet, not a floating popover: the page is a native child webview
   * that always paints above the main DOM, so a dropdown overlapping the page
   * would be invisible. Opening this shrinks the content rect (the same
   * ResizeObserver path the downloads panel uses) and the page moves under it.
   *
   * What is inside mirrors Firefox's application menu, minus the things this
   * browser genuinely does not have (private windows, passwords, Sync,
   * add-on store). uBlock Origin Lite is the one add-on; its real status lives in
   * BrowserSettings, so "Add-ons" and "Settings" are one truthful section
   * instead of two empty ones.
   */
  import { browser } from '../../stores/browser.svelte';
  import { downloads } from '../../stores/downloads.svelte';
  import { layout } from '../../stores/layout.svelte';
  import { app } from '../../stores/app.svelte';
  import { toast } from '../../stores/toast.svelte';
  import BrowserSettings from './BrowserSettings.svelte';

  const tab = $derived(browser.active);
  const canPage = $derived(!!tab && tab.url !== 'about:blank' && tab.url !== '');
  const bookmarked = $derived(canPage && browser.isBookmarked(tab!.url));

  type Item = {
    id:
      | 'new-tab'
      | 'downloads'
      | 'history'
      | 'bookmark'
      | 'pin'
      | 'home'
      | 'source'
      | 'page-download'
      | 'shortcuts'
      | 'close';
    label: string;
    kbd?: string;
    badge?: number;
    active?: boolean;
    disabled?: boolean;
    run: () => void;
  };

  /** Every menu row is one store call — no second navigation path. */
  const items = $derived.by<Item[]>(() => [
    {
      id: 'new-tab',
      label: 'New tab',
      kbd: 'Ctrl+T',
      run: () => browser.open()
    },
    {
      id: 'downloads',
      label: 'Downloads',
      kbd: 'Ctrl+J',
      badge: downloads.activeCount,
      run: () => downloads.toggle()
    },
    {
      id: 'history',
      label: 'History',
      kbd: 'Ctrl+H',
      run: () => browser.toggleHistory()
    },
    {
      id: 'bookmark',
      label: bookmarked ? 'Remove bookmark' : 'Bookmark this page',
      kbd: 'Ctrl+D',
      active: bookmarked,
      disabled: !canPage,
      run: () => {
        const t = browser.active;
        if (!t) return;
        const added = browser.toggleBookmark(t.url, t.title);
        toast.push('info', added ? `★ ${t.title} bookmark` : 'Bookmark hata diya');
      }
    },
    {
      id: 'pin',
      label: tab?.pinned ? 'Unpin tab' : 'Pin tab (background me chale)',
      active: !!tab?.pinned,
      disabled: !canPage,
      run: () => {
        const pinned = browser.togglePin();
        toast.push(
          'info',
          pinned ? '📌 Tab pin — dusre tab me bhi chalta rahega' : 'Pin hata diya'
        );
      }
    },
    {
      id: 'home',
      label: 'Speed dial & bookmarks',
      kbd: 'Alt+Home',
      run: () => browser.goHome()
    },
    {
      id: 'source',
      label: 'View page source',
      kbd: 'Ctrl+U',
      disabled: !canPage,
      run: () => browser.viewSource()
    },
    {
      id: 'page-download',
      label: 'Download this page (fast)',
      disabled: !canPage,
      run: () => void downloadPage()
    },
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      kbd: 'F1',
      run: () => (layout.helpOpen = true)
    },
    {
      id: 'close',
      label: 'Close browser',
      kbd: 'Ctrl+Shift+W',
      run: () => app.closeBrowser()
    }
  ]);

  /** Close the sheet, then run the row's action (panels would stack otherwise). */
  function pick(item: Item): void {
    if (item.disabled) return;
    browser.settingsOpen = false;
    item.run();
  }

  /** The one fast download action — the old second toolbar ⬇ lives here now. */
  async function downloadPage(): Promise<void> {
    const t = browser.active;
    if (!t || t.url === 'about:blank') return;
    try {
      await downloads.start(t.url, { referer: t.url });
      toast.push('info', '⬇ Download shuru — multi-segment speed me');
    } catch (err) {
      toast.push('warn', err instanceof Error ? err.message : 'Download start nahi hua');
    }
  }
</script>

<svelte:window
  onkeydowncapture={(e) => {
    // Esc closes the menu before it reaches the browser-wide "stop loading"
    // binding. Capture + stopPropagation keeps the two meanings separate.
    if (e.key === 'Escape' && browser.settingsOpen) {
      e.preventDefault();
      e.stopPropagation();
      browser.settingsOpen = false;
    }
  }}
/>

{#if browser.settingsOpen}
  <div
    class="shrink-0 border-b border-nc-line bg-nc-panel shadow-[0_8px_24px_rgba(0,0,0,0.25)]"
    aria-label="Browser menu"
  >
    <div class="flex h-9 items-center justify-between gap-2 border-b border-nc-line/60 px-3">
      <span class="text-[11px] font-semibold tracking-wide text-nc-mut uppercase">Menu</span>

      <div class="flex items-center gap-2">
        <!-- Firefox's zoom row: − 100% + , reset by clicking the number. -->
        <div
          class="flex h-6 items-center gap-0.5 rounded-full bg-nc-panel-2 p-0.5"
          role="group"
          aria-label="Page zoom"
        >
          <button
            type="button"
            onclick={() => browser.applyZoom(-1)}
            class="grid h-5 w-5 place-items-center rounded-full text-[13px] leading-none text-nc-mut hover:bg-nc-line hover:text-nc-txt disabled:opacity-35"
            title="Zoom out"
            aria-label="Zoom out"
            disabled={!canPage}
          >
            −
          </button>
          <button
            type="button"
            onclick={() => browser.applyZoom(0)}
            class="min-w-10 rounded-full px-1 text-[10px] font-semibold text-nc-txt hover:bg-nc-line disabled:opacity-35"
            title="Reset zoom to 100%"
            disabled={!canPage}
          >
            {Math.round(browser.zoomLevel * 100)}%
          </button>
          <button
            type="button"
            onclick={() => browser.applyZoom(1)}
            class="grid h-5 w-5 place-items-center rounded-full text-[13px] leading-none text-nc-mut hover:bg-nc-line hover:text-nc-txt disabled:opacity-35"
            title="Zoom in"
            aria-label="Zoom in"
            disabled={!canPage}
          >
            +
          </button>
        </div>

        <button
          type="button"
          onclick={() => (browser.settingsOpen = false)}
          class="grid h-6 w-6 place-items-center rounded-full text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
          title="Menu band karo (Esc)"
          aria-label="Close menu"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
    </div>

    <div
      class="grid max-h-[min(58vh,430px)] gap-4 overflow-y-auto px-3 py-2.5 md:grid-cols-[minmax(210px,0.85fr)_minmax(280px,1.15fr)]"
    >
      <!-- ── the Firefox-style list ────────────────────────────────────── -->
      <nav class="grid content-start gap-0.5" aria-label="Browser tools">
        {#each items as item (item.id)}
          <button
            type="button"
            onclick={() => pick(item)}
            disabled={item.disabled}
            class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors
                   disabled:cursor-not-allowed disabled:opacity-35
                   {item.active
              ? 'text-nc-brand hover:bg-nc-panel-2'
              : 'text-nc-txt hover:bg-nc-panel-2'}"
          >
            <span class="grid h-4 w-4 shrink-0 place-items-center text-nc-mut">
              {#if item.id === 'new-tab'}
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"><path d="M12 5v14M5 12h14" /></svg
                >
              {:else if item.id === 'downloads' || item.id === 'page-download'}
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></svg
                >
              {:else if item.id === 'history'}
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></svg
                >
              {:else if item.id === 'bookmark'}
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill={item.active ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linejoin="round"
                  ><path
                    d="M12 4l2.35 4.76 5.25.76-3.8 3.7.9 5.23L12 15.98l-4.7 2.47.9-5.23-3.8-3.7 5.25-.76z"
                  /></svg
                >
              {:else if item.id === 'pin'}
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill={item.active ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linejoin="round"><path d="M9 3h6l-1 5 3 3H7l3-3-1-5zM12 11v9" /></svg
                >
              {:else if item.id === 'home'}
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"><path d="M4 11l8-7 8 7M6 10v10h12V10" /></svg
                >
              {:else if item.id === 'source'}
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.9"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6" /></svg
                >
              {:else if item.id === 'shortcuts'}
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  ><circle cx="12" cy="12" r="9" /><path
                    d="M9.7 9a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .8-1 1.6M12 16.8h.01"
                  /></svg
                >
              {:else}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"><path d="M2 2l8 8M10 2l-8 8" /></svg
                >
              {/if}
            </span>
            <span class="min-w-0 flex-1 truncate">{item.label}</span>
            {#if item.badge}
              <span
                class="rounded-full bg-nc-brand px-1.5 text-[9px] font-bold text-white"
                aria-label={`${item.badge} active downloads`}>{item.badge}</span
              >
            {/if}
            {#if item.kbd}
              <kbd class="shrink-0 rounded bg-nc-panel-2 px-1 py-0.5 text-[9px] text-nc-mut"
                >{item.kbd}</kbd
              >
            {/if}
          </button>
        {/each}
      </nav>

      <!-- ── the settings that used to hide behind the downloads gear ─── -->
      <BrowserSettings />
    </div>

    <div
      class="flex items-center justify-between gap-2 border-t border-nc-line/50 px-3 py-1 text-[10px] text-nc-mut-2"
    >
      <span>F1 = saare keyboard shortcuts</span>
      <span>Esc = menu band</span>
    </div>
  </div>
{/if}
