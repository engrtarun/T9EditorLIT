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
   * greeting, a live clock, and the tab budget — one honest status chip
   * that reads the real store. Nothing here is decoration for its own sake.
   *
   * Everything renders in the *main* webview (Svelte DOM), so an empty tab
   * costs zero megabytes: the native page webview only exists once a real URL
   * is navigated to.
   */
  import { browser, SPEED_DIAL, toUrl } from '../../stores/browser.svelte';
  import { pinnedTools, hostOfUrl } from '../../stores/pinned-tools.svelte';
  import { getSearchEngine, setSearchEngine } from '../../search-engines.svelte';
  import SiteIcon from './SiteIcon.svelte';
  import EnginePicker from './EnginePicker.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { isTauri } from '../../ipc';

  let query = $state('');

  /**
   * One line at a time, swapped every 3 s with a small slide-up fade: the
   * promise under the search box is the first thing a new tab reads, so it
   * rotates through the things this browser is actually about instead of
   * freezing on one sentence. `prefers-reduced-motion` keeps the text but
   * stops the swap animation (the interval itself still runs — a changing
   * fact is content, not motion).
   */
  const TAGLINES = [
    'Sab kuch aapke PC par — koi cloud nahi, koi account nahi.',
    'Bol ke likho — Hinglish dictation, turant script me.',
    'In-built browser, downloader aur editor — sab ek jagah.',
    'Ad blocker on — koi tracker aapko peecha nahi karega.',
    'Koi login nahi, koi telemetry nahi — bas apna kaam karo.'
  ];
  let lineIdx = $state(0);
  $effect(() => {
    const id = setInterval(() => (lineIdx = (lineIdx + 1) % TAGLINES.length), 3000);
    return () => clearInterval(id);
  });

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
    now
      .toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
      .toUpperCase()
  );
  const today = $derived(
    now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })
  );

  /** The dial's own AI engine — the URL bar's web pick never touches it. */
  const engine = $derived(getSearchEngine('ai'));

  function search(e: SubmitEvent) {
    e.preventDefault();
    const raw = query.trim();
    if (!raw) return;
    browser.navigate(toUrl(raw, 'ai'));
    query = '';
  }

  function open(url: string) {
    browser.navigate(url);
  }

  /** The dial's engine chip — opens the AI-only picker under the box. */
  let dialWrap: HTMLDivElement | undefined = $state();

  function togglePicker(): void {
    browser.searchPickerOpen = browser.searchPickerOpen === 'dial' ? '' : 'dial';
  }

  function pickAiEngine(id: string): void {
    setSearchEngine(id);
    toast.push('info', `🔎 ${getSearchEngine('ai').name}`);
  }

  // The picker floats under the box; a click anywhere else closes it.
  $effect(() => {
    if (browser.searchPickerOpen !== 'dial') return;
    const el = dialWrap;
    const onDown = (ev: PointerEvent) => {
      const t = ev.target as Node | null;
      if (el && t && el.contains(t)) return;
      browser.searchPickerOpen = '';
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  });
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
        {#key lineIdx}
          <p class="tagline mt-1 text-[11px] text-nc-mut">{TAGLINES[lineIdx]}</p>
        {/key}
      </div>
      <div class="shrink-0 text-right">
        <p class="text-[30px] leading-none font-bold tabular-nums text-nc-txt">{clock}</p>
        <p class="mt-1 text-[9px] font-semibold tracking-[0.16em] text-nc-mut-2 uppercase">
          Local time
        </p>
      </div>
    </div>

    <!-- the one thing a new tab is for: an AI search box with the engine's
         real logo; the chip opens the AI-only picker under the box -->
    <div class="relative mt-6" bind:this={dialWrap}>
      <form
        onsubmit={search}
        class="dial-in dial-in-1 flex h-11 items-center gap-2.5 rounded-full border border-nc-line bg-nc-panel px-4
               shadow-[0_10px_30px_rgba(0,0,0,.28)] transition-colors
               focus-within:border-nc-brand focus-within:ring-2 focus-within:ring-nc-brand/20"
      >
        <button
          type="button"
          onclick={togglePicker}
          class="engine-chip group -ml-1 flex h-7 shrink-0 items-center gap-1 rounded-full pr-1.5 pl-1 transition-colors
                 hover:bg-nc-line {browser.searchPickerOpen === 'dial' ? 'bg-nc-line' : ''}"
          title="AI engine: {engine.name} — click to change"
          aria-label="Choose AI search engine"
          aria-haspopup="menu"
          aria-expanded={browser.searchPickerOpen === 'dial'}
        >
          <span class="engine-chip-logo">
            <SiteIcon url={engine.site} label={engine.name} size={18} shape="circle" />
          </span>
          <svg
            width="8"
            height="8"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            class="shrink-0 text-nc-mut transition-transform duration-200 ease-out
                   {browser.searchPickerOpen === 'dial' ? 'rotate-180' : ''}"
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <input
          bind:value={query}
          placeholder="AI se pooch, ya website ka address likho…"
          spellcheck="false"
          autocomplete="off"
          class="min-w-0 flex-1 bg-transparent text-[13px] leading-none text-nc-txt outline-none placeholder:text-nc-mut-2"
          aria-label="Search or enter a website"
        />
        <!-- ChatGPT's send mark: a filled circle with an up arrow. It reads as
             "run it" at a glance, and the fill gives the affordance the muted
             magnifier never had. A real submit button, so it does what Enter
             does. -->
        <button
          type="submit"
          class="search-go grid h-7 w-7 shrink-0 place-items-center rounded-full bg-nc-brand text-white
                 transition-[filter,transform] duration-150 hover:brightness-110
                 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nc-brand
                 {query.trim() ? '' : 'opacity-45'}"
          title="Search on web"
          aria-label="Search on web"
          disabled={!query.trim()}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
      {#if browser.searchPickerOpen === 'dial'}
        <EnginePicker group="ai" onpick={pickAiEngine} />
      {/if}
    </div>

    <!-- the tab budget — the one honest status chip left: it reads the
         live tab store and nothing else -->
    <div class="dial-in dial-in-2 mt-3 flex flex-wrap items-center gap-1.5">
      <span
        class="rounded-full border border-nc-line bg-nc-panel px-2.5 py-1 text-[10px] tabular-nums text-nc-mut"
      >
        {browser.tabs.length} / 9 tabs
      </span>
    </div>

    <!-- speed-dial sites — no section label: the icons speak for
         themselves, and the label only pushed them down the page -->
    <div class="dial-in dial-in-2 mt-7 grid grid-cols-3 gap-1 sm:grid-cols-6">
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
    <p class="mt-8 text-center font-brand text-[11px] tracking-[0.14em] text-nc-mut-2 uppercase">
      {isTauri() ? '' : 'dev preview · '}Everything opens in-app
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

  /*
   * Two small motions added with the AI search box:
   *
   *  1. the tagline swap — the line slides up and fades as the next one
   *     arrives from below, every 3 s. The `{#key}` remounts the <p>, so the
   *     animation always plays fresh; under reduced-motion the text still
   *     changes (it is content) but without the slide.
   *  2. the engine chip's logo settling in once, and popping on hover — the
   *     affordance for "click to switch AI engine".
   */
  @keyframes t9-tagline-swap {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes t9-logo-in {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .tagline {
    animation: t9-tagline-swap 320ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .engine-chip-logo {
    display: grid;
    place-items: center;
    animation: t9-logo-in 260ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .engine-chip:hover .engine-chip-logo {
    transform: scale(1.1);
    transition: transform 160ms ease-out;
  }

  /* The send mark presses like a physical button: a small squash on click.
     Its colour comes from the fill, so there is no focus tint to override. */
  .search-go {
    transition:
      filter 160ms ease-out,
      transform 120ms ease-out,
      opacity 160ms ease-out;
  }

  .search-go:active:not(:disabled) {
    transform: scale(0.9);
  }

  .search-go:disabled {
    cursor: default;
  }

  @media (prefers-reduced-motion: reduce) {
    .dial-in,
    .dial-card,
    .tagline,
    .engine-chip-logo {
      animation: none;
    }

    .engine-chip:hover .engine-chip-logo {
      transform: none;
    }

    .search-go,
    .search-go:active:not(:disabled) {
      transition: none;
      transform: none;
    }
  }
</style>
