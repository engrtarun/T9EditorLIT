<script lang="ts">
  /**
   * The address bar — Firefox Proton's pill, in the brand's tokens.
   *
   * It is **controlled by the active tab while unfocused**: the moment the
   * user clicks in, their draft takes over, so a page load mid-typing cannot
   * yank the text out from under the cursor. Enter runs `toUrl`, so a bare
   * `youtube.com` navigates and a phrase searches — one field, both jobs.
   */
  import { browser, toUrl } from '../../stores/browser.svelte';
  import { toast } from '../../stores/toast.svelte';

  let {
    ondownload
  }: {
    /** The ⬇ button lives in the toolbar row; the click is relayed up. */
    ondownload: () => void;
  } = $props();

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
    if (!raw || !tab) return;
    const url = toUrl(raw);
    if (!url) return;
    browser.navigate(url);
    // The bar shows the real URL again the moment navigation starts.
    draft = url;
    input?.blur();
    toast.push('info', `🌐 ${new URL(url).hostname}`);
  }
</script>

<form
  class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-transparent bg-nc-panel-2 px-2 transition-colors
         {focused ? 'border-nc-brand/70 bg-nc-panel' : 'hover:bg-nc-line/70'}"
  onsubmit={submit}
>
  <!-- lock: https gets the padlock, http gets a plain info mark -->
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

  <input
    bind:this={input}
    bind:value={draft}
    onfocus={() => (focused = true)}
    onblur={() => (focused = false)}
    placeholder={tab ? tab.url : 'Search ya address likho…'}
    spellcheck="false"
    autocomplete="off"
    class="min-w-0 flex-1 bg-transparent text-[13px] leading-none text-nc-txt outline-none placeholder:text-nc-mut"
    aria-label="Address bar"
  />

  <!-- download the page's file (or the typed URL) with the fast downloader -->
  <button
    type="button"
    onclick={ondownload}
    class="grid h-5 w-5 shrink-0 place-items-center rounded text-nc-mut transition-colors hover:bg-nc-line hover:text-nc-txt disabled:opacity-40"
    disabled={!tab || tab.url === 'about:blank'}
    title="Fast download (multi-segment, 1DM style)"
    aria-label="Download this page's file"
  >
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
    >
      <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
    </svg>
  </button>
</form>
