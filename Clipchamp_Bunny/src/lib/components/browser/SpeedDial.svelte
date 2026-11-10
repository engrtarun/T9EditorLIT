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
    <p class="dial-in text-center text-[11px] font-bold tracking-[0.22em] text-nc-mut-2 uppercase">
      Naya tab
    </p>

    <!-- the one thing a new tab is for -->
    <form
      onsubmit={search}
      class="dial-in dial-in-1 mt-3 flex h-11 items-center gap-2.5 rounded-full border border-nc-line bg-nc-panel px-4
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
    <p class="dial-in dial-in-2 mt-7 mb-2 px-1 text-[10px] font-bold tracking-widest text-nc-mut-2">
      SHORTCUTS
    </p>
    <div class="dial-in dial-in-2 grid grid-cols-3 gap-1 sm:grid-cols-6">
      {#each SPEED_DIAL as site, i (site.url)}
        <button
          type="button"
          onclick={() => open(site.url)}
          style="--i: {i}"
          class="dial-card group flex flex-col items-center gap-2 rounded-xl px-1 py-2.5 transition-colors hover:bg-nc-panel-2"
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

    <!-- bookmarks (Ctrl+D) — the user's own pins, persisted on this machine -->
    {#if browser.bookmarks.length > 0}
      <p class="mt-6 mb-2 px-1 text-[10px] font-bold tracking-widest text-nc-mut-2">
        BOOKMARKS · CTRL + D
      </p>
      <div class="grid grid-cols-3 gap-1 sm:grid-cols-6">
        {#each browser.bookmarks as site, i (site.url)}
          <div class="group relative">
            <button
              type="button"
              onclick={() => open(site.url)}
              style="--i: {i}"
              class="dial-card flex w-full flex-col items-center gap-2 rounded-xl px-1 py-2.5 transition-colors hover:bg-nc-panel-2"
              title="{site.url} — bookmark"
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
            <button
              type="button"
              onclick={() => browser.removeBookmark(site.url)}
              class="absolute top-0.5 right-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/50
                     text-[9px] text-white opacity-0 transition-opacity group-hover:opacity-100"
              title="Bookmark hatao"
              aria-label="Remove bookmark"
            >
              ✕
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- the user's own pins, same tiles, pinned in the 9-dots panel -->
    {#if pinnedTools.items.length > 0}
      <p class="mt-6 mb-2 px-1 text-[10px] font-bold tracking-widest text-nc-mut-2">AAPKE PINS</p>
      <div class="grid grid-cols-3 gap-1 sm:grid-cols-6">
        {#each pinnedTools.items as site, i (site.id)}
          <button
            type="button"
            onclick={() => open(site.url)}
            style="--i: {i}"
            class="dial-card group flex flex-col items-center gap-2 rounded-xl px-1 py-2.5 transition-colors hover:bg-nc-panel-2"
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

<style>
  /*
   * A short 3D entrance, not a bounce: the page tips forward out of the
   * screen once (rotateX + a little depth), and the shortcut tiles follow in
   * a 45 ms stagger, furthest-back first. It covers the one-frame blank that
   * a native-page webview unmount leaves behind, then stops — a new tab is a
   * quiet place, so nothing loops and nothing bounces.
   */
  @keyframes t9-dial-in {
    from {
      opacity: 0;
      transform: perspective(900px) rotateX(10deg) translate3d(0, 12px, -30px);
    }
    to {
      opacity: 1;
      transform: perspective(900px) rotateX(0deg) translate3d(0, 0, 0);
    }
  }

  @keyframes t9-dial-card {
    from {
      opacity: 0;
      transform: perspective(640px) rotateX(30deg) translate3d(0, 14px, -24px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: perspective(640px) rotateX(0deg) translate3d(0, 0, 0) scale(1);
    }
  }

  .dial-in {
    animation: t9-dial-in 280ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .dial-in-1 {
    animation-delay: 40ms;
  }

  .dial-in-2 {
    animation-delay: 90ms;
  }

  .dial-card {
    transform-origin: 50% 100%;
    animation: t9-dial-card 380ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
    animation-delay: calc(140ms + var(--i, 0) * 45ms);
  }

  @media (prefers-reduced-motion: reduce) {
    .dial-in,
    .dial-card {
      animation: none;
    }
  }
</style>
