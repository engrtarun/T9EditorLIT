<script lang="ts">
  /**
   * The address bar — Firefox 157's pill, in the brand's tokens.
   *
   * It is **controlled by the active tab while unfocused**: the moment the
   * user clicks in, their draft takes over, so a page load mid-typing cannot
   * yank the text out from under the cursor. Enter runs `toUrl`, so a bare
   * `youtube.com` navigates and a phrase searches — one field, both jobs.
   *
   * No download button lives here: the toolbar owns the fast downloader, and
   * two ⬇ buttons a few pixels apart is how a toolbar starts to feel cluttered.
   */
  import { browser, toUrl } from '../../stores/browser.svelte';
  import { toast } from '../../stores/toast.svelte';

  const tab = $derived(browser.active);

  let draft = $state('');
  let focused = $state(false);
  let input: HTMLInputElement | undefined = $state();

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

<form
  class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border px-3 transition-colors
         {focused
    ? 'border-nc-brand/70 bg-nc-bg ring-2 ring-nc-brand/20'
    : 'border-transparent bg-nc-panel-2 hover:bg-nc-line/60'}"
  aria-busy={tab?.loading ?? false}
  onsubmit={submit}
>
  <!-- lock: https gets the padlock, http gets a plain info mark. While the
       page loads it becomes a spinner — Chrome/Brave's "something is
       happening" cue where the security icon sits. -->
  {#if tab?.loading}
    <span
      class="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-nc-line border-t-nc-brand"
      aria-hidden="true"
    ></span>
  {:else}
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      class="shrink-0 {tab?.url.startsWith('https://') ? 'text-nc-mut' : 'text-nc-mut/60'}"
      aria-hidden="true"
    >
      {#if tab?.url.startsWith('https://')}
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

  <!-- Firefox's own trick: click the magnifier to focus from anywhere. -->
  <button
    type="button"
    onclick={() => {
      input?.focus();
      input?.select();
    }}
    class="grid h-5 w-5 shrink-0 place-items-center rounded-full text-nc-mut transition-colors hover:bg-nc-line hover:text-nc-txt"
    title="Address bar (Ctrl+L)"
    aria-label="Focus address bar"
  >
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.9"
    >
      <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" />
    </svg>
  </button>
</form>
