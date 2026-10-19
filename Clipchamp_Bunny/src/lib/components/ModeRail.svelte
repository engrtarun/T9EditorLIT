<script lang="ts">
  import { mode } from '../stores/mode.svelte';

  /* Clipchamp's rail is icon-over-label with a rounded pill on the active item.
     Ours switches the whole app MODE (each mode is a separate RAM island). */
  const ITEMS = [
    { id: 'ingest', label: 'Ingest', icon: 'M12 16V4M7 9l5-5 5 5M4 20h16' },
    { id: 'cut', label: '7:3 Cut', icon: 'M6 4v16M18 4v16M6 12h12' },
    { id: 'polish', label: 'Polish', icon: 'M4 7V5h16v2M9 19h6M12 5v14' },
    { id: 'export', label: 'Export', icon: 'M12 16V4M7 9l5-5 5 5M4 20h16' }
  ] as const;
</script>

<!-- LEFT RAIL — 58px, icon + label, rounded pill on active (Clipchamp metrics) -->
<nav
  data-focus="rail"
  tabindex="-1"
  class="flex w-[58px] shrink-0 flex-col items-center gap-0.5 border-r border-nc-line bg-nc-panel py-1.5 outline-none"
>
  {#each ITEMS as it (it.id)}
    <button
      onclick={() => mode.set(it.id)}
      class="flex w-[52px] flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-center transition-colors
             {mode.current === it.id
        ? 'bg-nc-panel-2 text-nc-txt'
        : 'text-nc-mut hover:bg-nc-panel-2/60 hover:text-nc-txt'}"
      title="{it.label} mode"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        class={mode.current === it.id ? 'text-nc-gold' : ''}
      >
        <path d={it.icon} />
      </svg>
      <span class="text-[9px] leading-[11px] font-medium">{it.label}</span>
    </button>
  {/each}

  <div class="flex-1"></div>

  <div
    class="px-1 pb-1 text-center text-[8px] leading-[10px] tracking-wider text-nc-mut-2"
    title="Only the mounted mode exists in RAM"
  >
    1 MODE<br />IN RAM
  </div>
</nav>
