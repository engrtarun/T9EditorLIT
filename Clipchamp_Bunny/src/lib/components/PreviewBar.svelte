<script lang="ts">
  import { project } from '../stores/project.svelte';
  import { player } from '../stores/player.svelte';
  import { mode } from '../stores/mode.svelte';
</script>

<!-- PREVIEW BAR — Clipchamp row: undo/redo | Size group | Share + Export -->
<div
  class="flex h-10 shrink-0 items-center gap-2 border-b border-nc-line bg-nc-panel px-3 select-none"
>
  <button
    onclick={() => project.undo()}
    disabled={project.past.length === 0}
    class="grid h-8 w-8 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-30"
    title="Undo (Ctrl+Z)"
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
    >
      <path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-1" />
    </svg>
  </button>
  <button
    onclick={() => project.redo()}
    disabled={project.future.length === 0}
    class="grid h-8 w-8 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-30"
    title="Redo (Ctrl+Y)"
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
    >
      <path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h1" />
    </svg>
  </button>

  <div class="flex-1"></div>

  <!-- Size / display group (Clipchamp pill) -->
  <div class="flex items-center gap-1 rounded-lg border border-nc-line bg-nc-panel-2 px-1.5 py-1">
    <button
      class="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[13px] hover:bg-nc-line"
      title="Canvas size"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 9v6M17 9v6" />
      </svg>
      Size
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-nc-mut">
        <path d="M7 10l5 5 5-5z" />
      </svg>
    </button>
    <span class="h-4 w-px bg-nc-line"></span>
    <button
      class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-line hover:text-nc-txt"
      title="Background image"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 15l4.5-4.5 3.5 3.5 3-3L21 17" />
        <circle cx="9" cy="9.5" r="1.2" />
      </svg>
    </button>
    <button
      class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-line hover:text-nc-txt"
      title="Gradient / colour"
    >
      <span
        class="h-3.5 w-3.5 rounded-full"
        style="background:conic-gradient(from 0deg, #d4af37, #e5484d, #7c5cff, #3dd68c, #d4af37)"
      ></span>
    </button>
  </div>

  <div class="flex-1"></div>

  <button
    class="flex items-center gap-1.5 rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-1.5 text-[13px] font-medium hover:bg-nc-line"
    title="Share"
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
    >
      <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
      <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" /><line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />
    </svg>
    Share
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" class="text-nc-mut">
      <path d="M7 10l5 5 5-5z" />
    </svg>
  </button>

  <button
    onclick={() => mode.set('export')}
    class="flex items-center gap-1.5 rounded-lg bg-nc-brand px-3.5 py-1.5 text-[13px] font-bold text-nc-bg hover:brightness-110"
    title="Export"
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
    </svg>
    Export
  </button>
</div>
