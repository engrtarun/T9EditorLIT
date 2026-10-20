<script lang="ts">
  /**
   * The dashboard's top bar.
   *
   * Clipchamp's header, minus everything that belongs to a *project* (the
   * project dropdown, the cloud toggle) — on the dashboard there is no project
   * open yet. What is left is the brand, the search box and the two buttons
   * that are always there.
   */
  import { app } from '../../stores/app.svelte';
  import { layout } from '../../stores/layout.svelte';
  import { menu } from '../../stores/menu.svelte';
  import CloudMenu from '../CloudMenu.svelte';
  import BrandMark from './BrandMark.svelte';
  import type { MenuItem } from '../../types';

  /** The search text lives in the dashboard — it filters the project list. */
  let { query = $bindable('') }: { query?: string } = $props();

  const SECTIONS: MenuItem[] = [
    { id: 'home', label: 'Home', icon: 'spark' },
    { id: 'videos', label: 'Your videos', icon: 'folder' },
    { id: 'trash', label: 'Trash', icon: 'trash' }
  ];

  function openLauncher(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    menu.show(SECTIONS, Math.round(r.left), Math.round(r.bottom + 4), (id) => {
      app.goHome(id as 'home' | 'videos' | 'trash');
    });
  }
</script>

<header
  data-focus="header"
  tabindex="-1"
  class="flex h-12 shrink-0 items-center gap-3 border-b border-nc-line bg-nc-panel pr-3 pl-2 select-none outline-none"
>
  <!-- app launcher (9 dots) -->
  <button
    onclick={openLauncher}
    class="grid h-8 w-8 shrink-0 place-items-center rounded-md text-nc-mut transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
    title="Go to"
    aria-haspopup="menu"
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="3" cy="3" r="1.4" /><circle cx="8" cy="3" r="1.4" /><circle
        cx="13"
        cy="3"
        r="1.4"
      />
      <circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle
        cx="13"
        cy="8"
        r="1.4"
      />
      <circle cx="3" cy="13" r="1.4" /><circle cx="8" cy="13" r="1.4" /><circle
        cx="13"
        cy="13"
        r="1.4"
      />
    </svg>
  </button>

  <!-- brand -->
  <div class="flex shrink-0 items-center gap-2">
    <BrandMark size={28} />
    <span class="text-[15px] font-semibold tracking-tight">
      T9 Editor <span class="text-nc-gold">LIT</span>
    </span>
  </div>

  <!-- search: the box keeps its size, only the border reacts -->
  <div class="flex flex-1 justify-center">
    <label class="relative block w-full max-w-[420px]">
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-nc-mut-2"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        bind:value={query}
        placeholder="Search your projects"
        aria-label="Search your projects"
        class="h-9 w-full rounded-lg border border-nc-line bg-nc-bg pr-3 pl-9 text-[13px] text-nc-txt
               transition-colors duration-150 outline-none placeholder:text-nc-mut-2
               focus:border-nc-gold/70"
      />
    </label>
  </div>

  <!-- cloud / providers -->
  <CloudMenu />

  <!-- help -->
  <button
    onclick={() => (layout.helpOpen = true)}
    class="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[15px] font-medium text-nc-mut transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
    title="Help · keyboard shortcuts (Ctrl + /)"
    aria-label="Help"
  >
    ?
  </button>

  <!-- avatar -->
  <div
    class="ml-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-nc-gold text-[10px] font-bold text-white"
    title="T9 Editor LIT"
  >
    TD
  </div>
</header>
