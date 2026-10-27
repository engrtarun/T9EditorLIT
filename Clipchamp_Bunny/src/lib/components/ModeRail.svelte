<script lang="ts">
  import { mode } from '../stores/mode.svelte';
  import { layout } from '../stores/layout.svelte';

  /* Clipchamp's rail is icon-over-label with a rounded pill on the active item.
     Ours is the same shape, but each entry is a separate RAM island — switching
     destroys the previous mode's component tree.

     Cut is the one mode. "My media" is not a mode — it toggles the library
     panel inside Cut: opening it brings the files back (import, then add them
     to the project timeline), closing it leaves no strip behind.
     Export stays on the preview bar's purple button, like Clipchamp. */
  const ITEMS = [{ id: 'cut', label: 'Cut', icon: 'M6 4v16M18 4v16M6 12h12' }] as const;

  /** The library is "on" while Cut runs and the panel is not collapsed. */
  const mediaOpen = $derived(mode.current === 'cut' && !layout.sourcePanelCollapsed);

  /** Rail's My media entry: toggle inside Cut; from elsewhere, land in Cut open. */
  function toggleMedia() {
    if (mode.current !== 'cut') {
      mode.set('cut');
      layout.setSourcePanelCollapsed(false);
      return;
    }
    layout.setSourcePanelCollapsed(!layout.sourcePanelCollapsed);
  }
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
        class={mode.current === it.id ? 'text-nc-brand' : ''}
      >
        <path d={it.icon} />
      </svg>
      <span class="text-[9px] leading-[11px] font-medium">{it.label}</span>
    </button>
  {/each}

  <!-- My media: the library-panel toggle (never a mode of its own) -->
  <button
    onclick={toggleMedia}
    class="flex w-[52px] flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-center transition-colors
           {mediaOpen
      ? 'bg-nc-panel-2 text-nc-txt'
      : 'text-nc-mut hover:bg-nc-panel-2/60 hover:text-nc-txt'}"
    title="My media — files import karo aur project timeline me add karo"
  >
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      class={mediaOpen ? 'text-nc-brand' : ''}
    >
      <rect x="3" y="5" width="18" height="14" rx="2" /><path
        d="M7.5 5v14M16.5 5v14M3 10h4.5M3 14h4.5M16.5 10H21M16.5 14H21"
      />
    </svg>
    <span class="text-[9px] leading-[11px] font-medium">My media</span>
  </button>
</nav>
