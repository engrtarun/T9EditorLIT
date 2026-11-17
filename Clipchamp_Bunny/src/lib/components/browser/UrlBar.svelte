<script lang="ts">
  /**
   * The address bar — Firefox 157's pill, in the brand's tokens.
   *
   * It is **controlled by the active tab while unfocused**: the moment the
   * user clicks in, their draft takes over, so a page load mid-typing cannot
   * yank the text out from under the cursor. Enter runs `toUrl`, so a bare
   * `youtube.com` navigates and a phrase searches — one field, both jobs.
   *
   * The engine chip on the left is Firefox's search-engine picker: the saved
   * engine's **real brand logo**, a chevron, and a dropdown grouped into the
   * free no-login AI engines and the classic web indexers. A pick becomes the
   * default for every later Enter (the speed dial included) and, when the
   * draft already looks like a search, runs it right now. The dropdown floats
   * over the content rect, so BrowserView parks the page while
   * `browser.searchPickerOpen` is true.
   *
   * No download button lives here: the toolbar owns the fast downloader, and
   * two ⬇ buttons a few pixels apart is how a toolbar starts to feel cluttered.
   */
  import { browser, toUrl } from '../../stores/browser.svelte';
  import { toast } from '../../stores/toast.svelte';
  import SiteIcon from './SiteIcon.svelte';
  import EnginePicker from './EnginePicker.svelte';
  import {
    getSearchEngine,
    isSearchQuery,
    searchUrlFor,
    setSearchEngine
  } from '../../search-engines.svelte';

  const tab = $derived(browser.active);

  let draft = $state('');
  let focused = $state(false);
  let input: HTMLInputElement | undefined = $state();

  /** The saved web engine, mirrored locally so the chip repaints after a pick. */
  let engine = $state(getSearchEngine('web'));
  let wrap: HTMLDivElement | undefined = $state();

  /** Unfocused → mirror the tab. Focused → the user's draft is sacred. */
  $effect(() => {
    if (!focused) draft = tab?.url === 'about:blank' ? '' : (tab?.url ?? '');
  });

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const raw = draft.trim();
    if (!raw) return;
    const url = toUrl(raw);
    if (!url) return;
    browser.navigate(url);
    // The bar shows the real URL again the moment navigation starts.
    draft = url;
    input?.blur();
    toast.push('info', `🌐 ${new URL(url).hostname}`);
  }

  function togglePicker(): void {
    browser.searchPickerOpen = browser.searchPickerOpen === 'urlbar' ? '' : 'urlbar';
    // Keep the keyboard where it already was: picking an engine must not
    // steal the caret out of a half-typed query.
    if (browser.searchPickerOpen) input?.focus();
  }

  /**
   * A pick does two jobs, exactly like Firefox's engine menu: it becomes the
   * default for next time, and — when the draft already reads like a search —
   * it runs that search now on the chosen engine.
   */
  function pickEngine(id: string): void {
    setSearchEngine(id);
    engine = getSearchEngine('web');
    const raw = draft.trim();
    if (raw && isSearchQuery(raw)) {
      const url = searchUrlFor(raw, 'web');
      browser.navigate(url);
      draft = url;
      input?.blur();
      toast.push('info', `🔎 ${engine.name}`);
      return;
    }
    toast.push('info', `Search engine: ${engine.name}`);
  }

  // The picker floats over the content rect, so an outside click must close
  // it — capture phase, without swallowing the click the user aimed at.
  $effect(() => {
    if (browser.searchPickerOpen !== 'urlbar') return;
    const el = wrap;
    const onDown = (ev: PointerEvent) => {
      const t = ev.target as Node | null;
      if (el && t && el.contains(t)) return;
      browser.searchPickerOpen = '';
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  });

  /** Ctrl+D's visible half: the star, filled while this page is pinned. */
  const bookmarked = $derived(!!tab && tab.url !== 'about:blank' && browser.isBookmarked(tab.url));

  function toggleStar() {
    const t = tab;
    if (!t || !t.url || t.url === 'about:blank') return;
    const added = browser.toggleBookmark(t.url, t.title);
    toast.push('info', added ? `★ ${t.title} bookmark` : 'Bookmark hata diya');
  }

  /**
   * Pin — Firefox's pinned tab, not a bookmark. The page's webview stays alive
   * (parked, never trimmed) when you leave the tab or the browser, so a
   * YouTube video keeps playing while you edit. Click again to unpin.
   */
  function togglePin() {
    const t = tab;
    if (!t || !t.url || t.url === 'about:blank') return;
    const pinned = browser.togglePin();
    toast.push('info', pinned ? '📌 Tab pinned — background me chalta rahega' : 'Pin hata diya');
  }

  /** The zoom chip's number — Firefox shows the percentage, not a ratio. */
  const zoomPct = $derived(Math.round(browser.zoomLevel * 100));
</script>

<div class="relative min-w-0" bind:this={wrap}>
  <form
    class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border px-3 transition-colors
           {focused
      ? 'border-nc-brand/70 bg-nc-bg ring-2 ring-nc-brand/20'
      : 'border-transparent bg-nc-panel-2 hover:bg-nc-line/60'}"
    aria-busy={tab?.loading ?? false}
    onsubmit={submit}
  >
    <!-- the search-engine picker: Firefox's engine chip, left of the lock.
         The chip shows the engine's REAL brand logo (fetched through
         SiteIcon), never a letter tile — the whole point of the picker. -->
    <button
      type="button"
      onclick={togglePicker}
      class="engine-chip group flex h-6 shrink-0 items-center gap-1 rounded-full pr-1.5 pl-1 transition-colors
             hover:bg-nc-line {browser.searchPickerOpen === 'urlbar' ? 'bg-nc-line' : ''}"
      title="Search engine: {engine.name}"
      aria-label="Choose search engine"
      aria-haspopup="menu"
      aria-expanded={browser.searchPickerOpen === 'urlbar'}
    >
      <span class="engine-chip-logo">
        <SiteIcon url={engine.site} label={engine.name} size={17} shape="circle" />
      </span>
      <svg
        width="8"
        height="8"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        class="shrink-0 text-nc-mut transition-transform duration-200 ease-out
               {browser.searchPickerOpen === 'urlbar' ? 'rotate-180' : ''}"
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>

    <!-- The security indicator, exactly where Firefox/Chrome keep it: a
         spinner while the page loads, a padlock on https, and the plain
         "i" mark on an unencrypted http page. It says nothing on a blank
         tab (no page, no security story), so it simply stays out of the
         way there instead of showing a meaningless icon. -->
    {#if tab?.loading}
      <span
        class="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-nc-line border-t-nc-brand"
        aria-hidden="true"
      ></span>
    {:else if tab && tab.url && tab.url !== 'about:blank'}
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        class="shrink-0 {tab.url.startsWith('https://') ? 'text-nc-mut' : 'text-nc-mut/60'}"
        aria-hidden="true"
      >
        {#if tab.url.startsWith('https://')}
          <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
        {:else}
          <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
        {/if}
      </svg>
    {/if}

    <input
      bind:this={input}
      bind:value={draft}
      data-urlbar-input
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
      placeholder={tab ? tab.url : 'Search ya address likho…'}
      spellcheck="false"
      autocomplete="off"
      class="min-w-0 flex-1 bg-transparent text-[13px] leading-none text-nc-txt outline-none placeholder:text-nc-mut"
      aria-label="Address bar"
    />

    <!-- Firefox's zoom indicator: absent at 100%, a brand chip otherwise.
         Clicking it snaps the page back to 100% (Firefox's "Reset zoom"). -->
    {#if tab && tab.url !== 'about:blank' && zoomPct !== 100}
      <button
        type="button"
        onclick={() => browser.applyZoom(0)}
        class="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums
               text-nc-brand transition-colors hover:bg-nc-line"
        title="Zoom {zoomPct}% — click to reset to 100%"
        aria-label="Zoom {zoomPct} percent, click to reset"
      >
        {zoomPct}%
      </button>
    {/if}

    <!-- pin (not the star): the live page keeps running in the background, so
         YouTube audio survives a trip to the editor. Immediately left of the
         bookmark star, where Firefox's pin lives in the address bar. -->
    <button
      type="button"
      onclick={togglePin}
      disabled={!tab || tab.url === 'about:blank'}
      class="grid h-5 w-5 shrink-0 place-items-center rounded-full transition-colors hover:bg-nc-line
             {tab?.pinned ? 'text-nc-brand' : 'text-nc-mut'}
             disabled:opacity-40 disabled:hover:bg-transparent"
      title={tab?.pinned ? 'Unpin tab' : 'Pin tab — background me chalta rahega'}
      aria-label={tab?.pinned ? 'Unpin tab' : 'Pin tab'}
      aria-pressed={tab?.pinned ?? false}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill={tab?.pinned ? 'currentColor' : 'none'}
        fill-opacity="0.25"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 17v5" />
        <path
          d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
        />
      </svg>
    </button>

    <!-- bookmark (Ctrl+D) — the Firefox star, live while the page is pinned -->
    <button
      type="button"
      onclick={toggleStar}
      disabled={!tab || tab.url === 'about:blank'}
      class="grid h-5 w-5 shrink-0 place-items-center rounded-full transition-colors hover:bg-nc-line
             {bookmarked
        ? 'text-nc-brand'
        : 'text-nc-mut'} disabled:opacity-40 disabled:hover:bg-transparent"
      title="Bookmark (Ctrl+D)"
      aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
      aria-pressed={bookmarked}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill={bookmarked ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linejoin="round"
      >
        <path
          d="M12 4l2.35 4.76 5.25.76-3.8 3.7.9 5.23L12 15.98l-4.7 2.47.9-5.23-3.8-3.7 5.25-.76z"
        />
      </svg>
    </button>

    <!-- The pointer half of Ctrl+L used to live here as a magnifier button;
         the keyboard path (App.svelte) still focuses the bar, and the
         engine chip already gives the bar a left-hand control. -->
  </form>

  {#if browser.searchPickerOpen === 'urlbar'}
    <EnginePicker group="web" onpick={pickEngine} />
  {/if}
</div>

<style>
  /*
   * Two small motions, neither decorative for its own sake:
   *
   *  1. the chip's logo settles in once when the bar renders (a page's
   *     favicon arrives late, so the scale is short and never repeats);
   *  2. the chip's logo pops slightly on hover — the affordance for
   *     "click to switch", matching the chevron that already rotates.
   *
   * The dropdown's own motion (menu open, row cascade, tick pop) lives in
   * EnginePicker, which owns the panel. Everything collapses to nothing
   * under prefers-reduced-motion.
   */
  @keyframes engine-logo-in {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .engine-chip-logo {
    display: grid;
    place-items: center;
    animation: engine-logo-in 260ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .engine-chip:hover .engine-chip-logo {
    transform: scale(1.08);
    transition: transform 160ms ease-out;
  }

  @media (prefers-reduced-motion: reduce) {
    .engine-chip-logo {
      animation: none;
    }

    .engine-chip:hover .engine-chip-logo {
      transform: none;
    }
  }
</style>
