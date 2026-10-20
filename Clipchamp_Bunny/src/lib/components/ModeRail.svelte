<script lang="ts">
  import { mode } from '../stores/mode.svelte';

  /* Clipchamp's rail is icon-over-label with a rounded pill on the active item.
     Ours is the same shape, but each entry is a separate RAM island — switching
     destroys the previous mode's component tree.

     Only two, and each maps to a real job:
       Media → import, probe, and strip the dead air
       Cut   → read the transcript, cut the fumbles
     Export lives on the preview bar's purple button, like Clipchamp. */
  const ITEMS = [
    {
      id: 'ingest',
      label: 'Media',
      icon: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
    },
    { id: 'cut', label: 'Cut', icon: 'M6 4v16M18 4v16M6 12h12' }
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
</nav>
