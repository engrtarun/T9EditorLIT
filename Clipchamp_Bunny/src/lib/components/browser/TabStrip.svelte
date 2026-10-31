<script lang="ts">
  /**
   * The tab strip — Firefox's shape: a row of rounded tabs with favicon,
   * title, a close ✕, and a `+` at the end. Hard-capped at nine.
   *
   * The cap is a *product* rule (plan: 9 tabs), so `+` goes disabled with an
   * explaining tooltip instead of silently doing nothing — the user asked for
   * the limit to be visible, and a dead button with a reason is visible.
   *
   * Each tab is a `div[role=tab]` holding **two** buttons (select + close):
   * a nested `<button>` is invalid HTML and screen readers mangle it.
   */
  import { browser, MAX_TABS, hostOf } from '../../stores/browser.svelte';
</script>

<div
  class="flex h-9 shrink-0 items-end gap-px overflow-x-auto border-b border-nc-line bg-nc-panel px-1 select-none"
  role="tablist"
  aria-label="Browser tabs"
>
  {#each browser.tabs as tab (tab.id)}
    <div
      role="tab"
      aria-selected={tab.id === browser.activeId}
      tabindex={tab.id === browser.activeId ? 0 : -1}
      onclick={() => browser.select(tab.id)}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          browser.select(tab.id);
        }
      }}
      class="group flex h-8 min-w-[110px] max-w-[190px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg px-2 text-[12px] transition-colors
             {tab.id === browser.activeId
        ? 'bg-nc-panel-2 text-nc-txt'
        : 'text-nc-mut hover:bg-nc-panel-2/60 hover:text-nc-txt'}"
      title={tab.url === 'about:blank' ? 'New tab' : tab.url}
    >
      <!-- favicon (or the globe) + a spinner while the page loads -->
      <span class="grid h-4 w-4 shrink-0 place-items-center overflow-hidden">
        {#if tab.loading}
          <span
            class="h-3 w-3 animate-spin rounded-full border border-nc-mut border-t-transparent"
            aria-hidden="true"
          ></span>
        {:else if tab.favicon}
          <img src={tab.favicon} alt="" class="h-4 w-4 object-contain" loading="lazy" />
        {:else}
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" /><path
              d="M3 12h18M12 3c2.5 2.6 4 5.7 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.7-4-9s1.5-6.4 4-9z"
            />
          </svg>
        {/if}
      </span>

      <span class="min-w-0 flex-1 truncate text-left">
        {tab.url === 'about:blank' ? 'New tab' : tab.title || hostOf(tab.url)}
      </span>

      <!-- close — always visible on the active tab, on hover for the rest -->
      <button
        type="button"
        onclick={(e) => {
          e.stopPropagation();
          browser.close(tab.id);
        }}
        aria-label="Close tab"
        class="grid h-4 w-4 shrink-0 place-items-center rounded-sm transition-opacity
               {tab.id === browser.activeId ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>
  {/each}

  <!-- new tab — disabled with a reason at the cap -->
  <button
    type="button"
    onclick={() => browser.open()}
    disabled={browser.atCap}
    class="mb-0.5 ml-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-nc-mut transition-colors
           {browser.atCap
      ? 'cursor-not-allowed opacity-40'
      : 'hover:bg-nc-panel-2 hover:text-nc-txt'}"
    title={browser.atCap
      ? `${MAX_TABS} tabs ki limit hai — pehle ek band karo`
      : 'New tab (Ctrl+T)'}
    aria-label={browser.atCap ? 'Tab limit reached' : 'New tab'}
  >
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  </button>

  {#if browser.atCap}
    <span
      class="mb-1.5 ml-1 shrink-0 rounded-full bg-nc-panel-2 px-2 py-0.5 text-[10px] text-nc-mut"
    >
      {browser.tabs.length}/{MAX_TABS} tabs
    </span>
  {/if}
</div>
