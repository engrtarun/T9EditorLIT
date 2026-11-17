<script lang="ts">
  /**
   * The "Search with" dropdown — Firefox's engine menu, shared by the
   * address-bar chip and the speed dial's search box so the two pickers are
   * literally the same panel: same real brand logos, same staggered entry.
   *
   * `group` decides which list it draws: the URL bar asks for `'web'` (the
   * classic index searchers), the dial asks for `'ai'` (the free no-login
   * answer engines). Each host therefore owns its own saved default — a pick
   * here never steals the other box's engine.
   *
   * It owns only the panel. Positioning, the outside-click close and the
   * "does this pick run a search right now?" decision belong to the host —
   * the URL bar runs a half-typed draft, the dial runs its own field.
   * Escape closes it from anywhere: the capture-phase listener lives here so
   * both hosts get it without duplicating the trick.
   *
   * The panel floats over the content rect, so BrowserView parks the page
   * while `browser.searchPickerOpen` is true.
   */
  import { browser } from '../../stores/browser.svelte';
  import { SEARCH_ENGINES, getSearchEngine, type EngineGroup } from '../../search-engines.svelte';
  import SiteIcon from './SiteIcon.svelte';

  let {
    group,
    onpick
  }: {
    group: EngineGroup;
    onpick: (id: string) => void;
  } = $props();

  const engine = $derived(getSearchEngine(group));
  const rows = $derived(SEARCH_ENGINES.filter((e) => e.group === group));

  const GROUP_LABEL: Record<EngineGroup, string> = {
    ai: 'AI · free, no login',
    web: 'Classic web'
  };

  function pick(id: string): void {
    browser.searchPickerOpen = '';
    onpick(id);
  }
</script>

<svelte:window
  onkeydowncapture={(e) => {
    // Escape closes whichever picker is open before the browser-wide "stop
    // loading" binding sees it. Capture + stopPropagation keeps the meanings
    // separate.
    if (e.key !== 'Escape' || !browser.searchPickerOpen) return;
    browser.searchPickerOpen = '';
    e.stopPropagation();
  }}
/>

<div
  class="engine-menu absolute top-full left-0 z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-nc-line
         bg-nc-panel p-1 shadow-[0_18px_44px_rgba(0,0,0,.5)]"
  role="menu"
  aria-label="Search engines"
>
  <p class="px-2.5 pt-1.5 pb-1 text-[9px] font-bold tracking-widest text-nc-mut-2 uppercase">
    Search with
  </p>

  <p
    class="engine-group-label px-2.5 pt-1 pb-0.5 text-[8.5px] font-bold tracking-[0.14em] text-nc-mut-2/80 uppercase"
  >
    {GROUP_LABEL[group]}
  </p>
  {#each rows as e, i (e.id)}
    <button
      type="button"
      onclick={() => pick(e.id)}
      style="--i: {i}"
      class="engine-row group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12px]
             transition-colors hover:bg-nc-panel-2 {engine.id === e.id
        ? 'bg-nc-panel-2/70 text-nc-txt'
        : 'text-nc-mut'}"
      role="menuitemradio"
      aria-checked={engine.id === e.id}
    >
      <span class="engine-row-logo">
        <SiteIcon url={e.site} label={e.name} size={18} shape="circle" />
      </span>
      <span class="min-w-0 flex-1 truncate group-hover:text-nc-txt">{e.name}</span>
      {#if engine.id === e.id}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          class="engine-check shrink-0 text-nc-brand"
          aria-hidden="true"
        >
          <path d="M5 13l4 4L19 7" />
        </svg>
      {/if}
    </button>
  {/each}
</div>

<style>
  /*
   * The panel opens from its top-left corner and the rows cascade in from
   * the left, 18 ms apart: the eye reads the list top-to-bottom instead of a
   * block landing at once. The selected tick pops with a little overshoot so
   * "this one is active" is noticed without reading. All of it stops under
   * prefers-reduced-motion.
   */
  @keyframes engine-menu-in {
    from {
      opacity: 0;
      transform: translateY(-6px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @keyframes engine-row-in {
    from {
      opacity: 0;
      transform: translateX(-6px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @keyframes engine-check-in {
    from {
      opacity: 0;
      transform: scale(0.4);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .engine-menu {
    transform-origin: top left;
    animation: engine-menu-in 160ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
  }

  .engine-group-label {
    animation: engine-row-in 200ms ease-out both;
  }

  .engine-row {
    animation: engine-row-in 220ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
    /* 18 ms apart: visible as a cascade, short enough that the last row is
       clickable well under 300 ms. */
    animation-delay: calc(40ms + var(--i, 0) * 18ms);
  }

  .engine-row .engine-row-logo {
    display: grid;
    place-items: center;
    transition: transform 160ms ease-out;
  }

  .engine-row:hover .engine-row-logo {
    transform: scale(1.12);
  }

  .engine-check {
    animation: engine-check-in 200ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }

  @media (prefers-reduced-motion: reduce) {
    .engine-menu,
    .engine-group-label,
    .engine-row,
    .engine-check {
      animation: none;
    }

    .engine-row:hover .engine-row-logo {
      transform: none;
    }
  }
</style>
