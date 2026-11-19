<script lang="ts">
  /**
   * The browser's tabs, as icon chips in the top bar.
   *
   * The old `TabStrip` was its own 40 px row above the address bar — Firefox's
   * shape, and it cost every page 40 px of height forever. The user's spec:
   * "kul mila ke ye patti hat jaygi is update me", with the tabs living in the
   * header as favicons instead ("is patti me tab ke icon se hone jaise img h").
   *
   * The chip row follows Firefox's own rule, asked for directly:
   * "logo title × — like firefox; jaise hi dusri tab me jaunga wapas icon
   * only". So every tab is a 28 px favicon square, and the one you are ON
   * stretches open — favicon, title, close ✕ — then folds back to an icon the
   * moment you switch away. Hard-capped at nine, exactly as before: `+` sits
   * next to this row in TopBar and explains the cap instead of doing nothing.
   *
   * One refinement on top of that ("title tab ka tabhi dikhe jab wo khuli
   * ho"): the stretch only happens for a tab that has a REAL page in it.
   * The Home/new-tab is the browser's own dial, not a site — it stays a 28
   * px icon, and with the brand ring gone the active chip reads as "no blue, icon only" - every tab icon is plain, like the first YT chip the user showed.
   * the user asked that every tab icon is plain.
   *
   * The row is mounted in ALL THREE headers (dashboard, studio, browser) —
   * "jagah badhne se matlab hai ki kuch jagah jaise home page of app ya
   * studio me nahi dikhte fix karo" — and a click from outside the browser
   * opens the view on that tab, which makes the chips a screen switcher too.
   *
   * A tab whose page owns the media session wears Firefox's speaker badge
   * over its favicon ("agar is tab me koi video play ho rahi hoti to wo icon
   * like firefox dikhe — icon + png"), so a video playing in a background tab
   * is findable without scanning every favicon. The store gets the state from
   * Rust's `browser:media` heartbeat.
   *
   * Each chip is a `div[role=tab]` holding **two** buttons (select + close):
   * a nested `<button>` is invalid HTML and screen readers mangle it.
   */
  import { browser, MAX_TABS, hostOf } from '../../stores/browser.svelte';
  import { app } from '../../stores/app.svelte';
  import SiteIcon from './SiteIcon.svelte';

  /**
   * The chips live in every top bar (Home, Studio, browser), so a click has
   * to work from any of them: pick the tab first, then bring the browser up
   * on it when the view is not open yet. The mount chain does the first
   * `show` — a `nudge` fired while the view is closed is refused by Rust
   * (diag only, no toast), so the order is safe either way.
   */
  function pick(id: string): void {
    browser.select(id);
    if (app.view !== 'browser') app.openBrowser(app.view);
  }

  /** The tab's page URL, or `null` for the new-tab page (globe, no icon). */
  function pageUrl(url: string): string | null {
    return url === 'about:blank' || url === '' ? null : url;
  }

  /** Arrow keys inside the list move focus with the selection, as a tablist should. */
  function onKey(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(id);
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    browser.cycle(e.key === 'ArrowRight' ? 1 : -1);
    const next = browser.activeId;
    if (next) document.getElementById('tab-chip-' + next)?.focus();
  }

  /* ------------------------------------------------------ the switch slide
   * "jab 2ungli se tab switch hoti h so koi animation nahi aata" — every
   * switch now nudges the row in the direction of travel and lets it settle.
   * Web Animations API on purpose: remounting the row to restart a CSS class
   * would drop keyboard focus and re-fetch every favicon.
   */
  let row: HTMLDivElement | null = $state(null);
  $effect(() => {
    const seq = browser.switchSeq;
    const el = row;
    if (!el || seq === 0) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dir = browser.switchDir;
    el.animate(
      [
        { transform: `translateX(${16 * dir}px)`, opacity: 0.55 },
        { transform: 'translateX(0)', opacity: 1 }
      ],
      { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
    );
  });
</script>

<div
  bind:this={row}
  class="flex shrink-0 items-center gap-1"
  role="tablist"
  aria-label="Browser tabs"
>
  {#each browser.tabs as tab (tab.id)}
    {@const icon = pageUrl(tab.url)}
    {@const active = tab.id === browser.activeId}
    {@const playing = tab.id === browser.playingId}
    <!-- Selected ≠ titled: only the tab you are ON **while its page is on
         screen** stretches open with a title ("title tab ka tabhi dikhe jab
         wo khuli ho"). On the app's Home and in the Studio the browser is
         closed, so every chip there is an icon — a title over a tab that is
         not open is a claim about something you cannot see. `active` alone
         still drives the ring, the roving tabindex and aria-selected. -->
    {@const titled = active && icon !== null && app.view === 'browser'}
    <div
      id={'tab-chip-' + tab.id}
      role="tab"
      aria-selected={active}
      aria-busy={tab.loading}
      tabindex={active ? 0 : -1}
      onclick={() => pick(tab.id)}
      onkeydown={(e) => onKey(e, tab.id)}
      class="group relative flex h-7 shrink-0 cursor-pointer items-center rounded-lg
             transition-colors duration-150
             {active
        ? 'text-nc-txt ring-1 ring-nc-line/50'
        : 'text-nc-mut ring-1 ring-transparent hover:bg-nc-panel-2/70 hover:text-nc-txt'}
             {titled ? 'w-auto max-w-[190px] px-1.5' : 'w-7 justify-center px-0'}"
      title={titled ? undefined : tab.title || (icon ? hostOf(icon) : 'Home')}
    >
      <!-- favicon (or the home mark) + a spinner while the page loads.
           The wrapper stays overflow-visible so the speaker badge below can
           hang off the corner; only the icon itself clips. -->
      <span class="relative shrink-0">
        <span class="grid h-4 w-4 place-items-center overflow-hidden">
          {#if tab.loading}
            <span
              class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-nc-line border-t-nc-brand"
              aria-hidden="true"
            ></span>
          {:else if icon}
            <SiteIcon url={icon} label={tab.title || hostOf(icon)} size={16} />
          {:else}
            <!-- Firefox's home mark: roof, walls, door — one stroke, reads at
                 14 px. It rides on a frosted disc ("home tab ka icon circule
                 + transparent sa ho halka blur taki bg per na chamke"): the
                 glyph itself is dimmed so it sits into the wallpaper instead
                 of glaring off it. -->
            <span
              class="grid h-4 w-4 place-items-center rounded-full bg-nc-txt/[0.06] ring-1 ring-nc-txt/10 backdrop-blur-[2px]"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="opacity-70"
                aria-hidden="true"
              >
                <path d="M3.5 10.8 12 4l8.5 6.8" />
                <path d="M5.7 9.6V20h12.6V9.6" />
                <path d="M9.8 20v-5h4.4v5" />
              </svg>
            </span>
          {/if}
        </span>

        <!-- Firefox's audible badge: the favicon png stays, the speaker rides
             on top of it, so "playing" reads at a glance. -->
        {#if playing}
          <span
            class="absolute -right-1.5 -bottom-1 grid h-3 w-3 place-items-center rounded-full
                   bg-nc-brand text-white ring-1 ring-nc-panel"
            title="Ye tab me chal rahi hai"
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-label="Playing"
              role="img"
            >
              <path d="M4 9v6h3.6L13 19.4V4.6L7.6 9H4z" />
              <path
                d="M16.2 8.6a5 5 0 0 1 0 6.8"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
          </span>
        {/if}
      </span>

      <!-- the title: only a titled chip (active AND a real page) carries it,
           and it collapses back to zero width on switch — the icon-only row
           returns instantly. The dial never gets one. -->
      <span
        class="overflow-hidden text-[11px] leading-none whitespace-nowrap transition-all duration-150
               {titled ? 'max-w-[140px] opacity-100' : 'max-w-0 opacity-0'}"
      >
        {tab.title || (icon ? hostOf(icon) : 'Home')}
      </span>

      {#if tab.pinned}
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
          class="absolute -top-0.5 -left-0.5 text-nc-brand"
          aria-label="Pinned tab"
        >
          <path d="M9 3h6l-1 5 3 3H7l3-3-1-5zM12 11v9" />
        </svg>
      {/if}

      <!-- close: inside a titled chip (Firefox's position), a corner ✕ on
           hover for everything else — the dial included -->
      <button
        type="button"
        onclick={(e) => {
          e.stopPropagation();
          browser.close(tab.id);
        }}
        aria-label="Close tab"
        class={titled
          ? 'relative ml-1 grid h-4 w-4 shrink-0 place-items-center rounded-full text-nc-mut hover:bg-nc-line hover:text-nc-txt'
          : 'absolute -top-1 -right-1 grid h-4 w-4 place-items-center rounded-full border border-nc-line bg-nc-panel text-nc-txt transition-opacity duration-150 opacity-0 group-hover:opacity-100'}
      >
        <svg
          width="7"
          height="7"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>
  {/each}

  <!-- the cap, where the eye already is: only when it is real -->
  {#if browser.atCap}
    <span
      class="ml-0.5 shrink-0 rounded-full bg-nc-panel-2 px-2 py-0.5 text-[10px] font-medium text-nc-mut"
      title={`${MAX_TABS} tabs ki limit hai — pehle ek band karo`}
    >
      {browser.tabs.length}/{MAX_TABS}
    </span>
  {/if}
</div>
