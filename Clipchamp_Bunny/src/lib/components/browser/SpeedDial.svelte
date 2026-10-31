<script lang="ts">
  /**
   * The new-tab page — Firefox 157's shortcut grid, in the brand's tokens.
   *
   * A search field first (that is what a new tab is for), then the shortcuts:
   * the six sites a T9 user actually opens, then whatever they pinned in the
   * 9-dots panel. Each shortcut is a light rounded tile with the site's real
   * favicon — or a letter tile when the icon cannot be fetched — so the page
   * never shows a broken image.
   *
   * Everything renders in the *main* webview (Svelte DOM), so an empty tab
   * costs zero megabytes: the native page webview only exists once a real URL
   * is navigated to.
   */
  import { browser, SPEED_DIAL, toUrl } from '../../stores/browser.svelte';
  import { pinnedTools, hostOfUrl } from '../../stores/pinned-tools.svelte';
  import SiteIcon from './SiteIcon.svelte';
  import { isTauri } from '../../ipc';

  let query = $state('');

  function search(e: SubmitEvent) {
    e.preventDefault();
    const raw = query.trim();
    if (!raw) return;
    browser.navigate(toUrl(raw));
    query = '';
  }

  function open(url: string) {
    browser.navigate(url);
  }
</script>

<div class="flex h-full min-h-0 flex-col overflow-y-auto px-6 py-8">
  <div class="mx-auto w-full max-w-[660px]">
    <p class="text-center text-[11px] font-bold tracking-[0.22em] text-nc-mut-2 uppercase">
      Naya tab
    </p>

    <!-- the one thing a new tab is for -->
    <form
      onsubmit={search}
      class="mt-3 flex h-11 items-center gap-2.5 rounded-full border border-nc-line bg-nc-panel px-4
             shadow-[0_10px_30px_rgba(0,0,0,.28)] transition-colors
             focus-within:border-nc-brand focus-within:ring-2 focus-within:ring-nc-brand/20"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
        class="shrink-0 text-nc-mut"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" />
      </svg>
      <input
        bind:value={query}
        placeholder="Search ya website ka address likho…"
        spellcheck="false"
        autocomplete="off"
        class="min-w-0 flex-1 bg-transparent text-[13px] leading-none text-nc-txt outline-none placeholder:text-nc-mut-2"
        aria-label="Search or enter a website"
      />
      <kbd
        class="shrink-0 rounded border border-nc-line-2 bg-nc-panel-2 px-1.5 py-0.5 text-[10px] text-nc-mut-2"
        >↵</kbd
      >
    </form>

    <!-- shortcuts -->
    <p class="mt-7 mb-2 px-1 text-[10px] font-bold tracking-widest text-nc-mut-2">SHORTCUTS</p>
    <div class="grid grid-cols-3 gap-1 sm:grid-cols-6">
      {#each SPEED_DIAL as site (site.url)}
        <button
          type="button"
          onclick={() => open(site.url)}
          class="group flex flex-col items-center gap-2 rounded-xl px-1 py-2.5 transition-colors hover:bg-nc-panel-2"
          title="{site.url} — in-built browser me khulega"
        >
          <span
            class="grid h-12 w-12 place-items-center rounded-xl border border-nc-line/70 bg-white/95
                   shadow-sm transition-colors group-hover:border-nc-line-2"
          >
            <SiteIcon url={site.url} label={site.label} size={26} />
          </span>
          <span class="max-w-full truncate text-[11px] text-nc-mut group-hover:text-nc-txt">
            {site.label}
          </span>
        </button>
      {/each}
    </div>

    <!-- the user's own pins, same tiles, pinned in the 9-dots panel -->
    {#if pinnedTools.items.length > 0}
      <p class="mt-6 mb-2 px-1 text-[10px] font-bold tracking-widest text-nc-mut-2">AAPKE PINS</p>
      <div class="grid grid-cols-3 gap-1 sm:grid-cols-6">
        {#each pinnedTools.items as site (site.id)}
          <button
            type="button"
            onclick={() => open(site.url)}
            class="group flex flex-col items-center gap-2 rounded-xl px-1 py-2.5 transition-colors hover:bg-nc-panel-2"
            title="{site.url} — in-built browser me khulega"
          >
            <span
              class="grid h-12 w-12 place-items-center rounded-xl border border-nc-line/70 bg-white/95
                     shadow-sm transition-colors group-hover:border-nc-line-2"
            >
              <SiteIcon url={site.url} label={site.name} size={26} />
            </span>
            <span class="max-w-full truncate text-[11px] text-nc-mut group-hover:text-nc-txt">
              {site.name}
            </span>
            <span class="max-w-full truncate text-[9px] text-nc-mut-2/70"
              >{hostOfUrl(site.url)}</span
            >
          </button>
        {/each}
      </div>
    {/if}

    <!-- the cap, stated where the user counts cards -->
    <div class="mt-8 flex flex-wrap items-center justify-center gap-2">
      <span
        class="rounded-full border border-nc-line bg-nc-panel px-2.5 py-1 text-[10px] text-nc-mut"
      >
        {browser.tabs.length} / 9 tabs
      </span>
      <span class="text-[10px] text-nc-mut-2">
        Sab kuch app ke andar khulta hai — koi link system browser me nahi jata.
        {isTauri() ? '' : '(dev preview)'}
      </span>
    </div>
  </div>
</div>
