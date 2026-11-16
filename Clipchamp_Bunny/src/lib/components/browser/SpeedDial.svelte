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
   * Above the field sits the part a visitor notices first: a time-aware
   * greeting, a live clock, and three honest status chips (ad blocker, tab
   * budget, search engine). Nothing here is decoration for its own sake — each
   * chip reads a real store, and the clock never claims a number it does not
   * have.
   *
   * Everything renders in the *main* webview (Svelte DOM), so an empty tab
   * costs zero megabytes: the native page webview only exists once a real URL
   * is navigated to.
   */
  import { browser, SPEED_DIAL, toUrl } from '../../stores/browser.svelte';
  import { pinnedTools, hostOfUrl } from '../../stores/pinned-tools.svelte';
  import { ublock } from '../../stores/ublock.svelte';
  import { getSearchEngine } from '../../search-engines';
  import SiteIcon from './SiteIcon.svelte';
  import { isTauri } from '../../ipc';

  let query = $state('');

  /** The clock ticks every 15 s, so the minute counter flips within one tick. */
  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => (now = new Date()), 15_000);
    return () => clearInterval(id);
  });

  const greeting = $derived.by(() => {
    const h = now.getHours();
    if (h < 5) return 'Shubh ratri';
    if (h < 12) return 'Suprabhat';
    if (h < 17) return 'Namaste';
    if (h < 21) return 'Shubh sandhya';
    return 'Shubh ratri';
  });

  const clock = $derived(
    now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
  );
  const today = $derived(
    now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })
  );

  /** Display-only: the URL bar owns the pick; the dial just mirrors it. */
  const engine = $derived(getSearchEngine());

  /** Green = WebView2 loaded the blocker, red = it did not, grey = no answer. */
  const shieldTone = $derived(
    ublock.runtime === 'loaded'
      ? 'bg-emerald-400'
      : ublock.runtime === 'missing'
        ? 'bg-red-400'
        : 'bg-nc-mut-2'
  );

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

<div
  class="relative flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-b from-nc-bg via-nc-bg to-nc-panel/40 px-6 py-8"
>
  <!-- one soft brand glow, behind everything, pointer-inert -->
  <div
    class="pointer-events-none absolute -top-24 left-1/2 h-64 w-[560px] -translate-x-1/2 rounded-full bg-nc-brand/10 blur-3xl"
    aria-hidden="true"
  ></div>

  <div class="relative mx-auto w-full max-w-[660px]">
    <!-- hero: greeting + live clock -->
    <div class="dial-in flex items-end justify-between gap-4">
      <div class="min-w-0">
        <p class="text-[11px] font-semibold tracking-[0.18em] text-nc-mut-2 uppercase">
          {today}
        </p>
        <h1 class="mt-1 truncate text-[26px] leading-tight font-semibold text-nc-txt">
          {greeting}
        </h1>
        <p class="mt-1 text-[11px] text-nc-mut">
          Sab kuch aapke PC par — koi cloud nahi, koi account nahi.
        </p>
      </div>
      <div class="shrink-0 text-right">
        <p class="text-[30px] leading-none font-bold tabular-nums text-nc-txt">{clock}</p>
        <p class="mt-1 text-[9px] font-semibold tracking-[0.16em] text-nc-mut-2 uppercase">
          Local time
        </p>
      </div>
    </div>

    <!-- the one thing a new tab is for -->
    <form
      onsubmit={search}
      class="dial-in dial-in-1 mt-6 flex h-11 items-center gap-2.5 rounded-full border border-nc-line bg-nc-panel px-4
             shadow-[0_10px_30px_rgba(0,0,0,.28)] transition-colors
             focus-within:border-nc-brand focus-within:ring-2 focus-within:ring-nc-brand/20"
    >
      <span
        class="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white"
        style="background:{engine.color}"
        title="Search engine: {engine.name} — URL bar me badlo"
      >
        {engine.letter}
      </span>
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

    <!-- honest status chips: every dot reads a real store -->
    <div class="dial-in dial-in-2 mt-3 flex flex-wrap items-center gap-1.5">
      <span
        class="flex items-center gap-1.5 rounded-full border border-nc-line bg-nc-panel px-2.5 py-1 text-[10px] text-nc-mut"
        title={ublock.runtime === 'loaded'
          ? `uBlock Origin Lite${ublock.version ? ` v${ublock.version}` : ''} WebView2 me load hai`
          : ublock.runtime === 'missing'
            ? 'Ad blocker WebView2 me load nahi hua — menu me check karo'
            : 'Ad blocker status abhi pata nahi'}
      >
        <span class="h-1.5 w-1.5 rounded-full {shieldTone}"></span>
        uBlock Lite{ublock.version ? ` · v${ublock.version}` : ''}
      </span>
      <span
        class="rounded-full border border-nc-line bg-nc-panel px-2.5 py-1 text-[10px] tabular-nums text-nc-mut"
      >
        {browser.tabs.length} / 9 tabs
      </span>
      <span
        class="flex items-center gap-1.5 rounded-full border border-nc-line bg-nc-panel px-2.5 py-1 text-[10px] text-nc-mut"
        title="Search engine — URL bar ki chip se badlo"
      >
        <span class="h-1.5 w-1.5 rounded-full" style="background:{engine.color}"></span>
        {engine.name}
      </span>
    </div>

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

    <!-- the one-line promise, stated where the user counts cards -->
    <p class="mt-8 text-center text-[10px] text-nc-mut-2">
      Sab kuch app ke andar khulta hai — koi link system browser me nahi jata.
      {isTauri() ? '' : '(dev preview)'}
    </p>
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
