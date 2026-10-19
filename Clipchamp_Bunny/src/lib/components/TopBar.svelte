<script lang="ts">
  import { mode, MODE_LABEL } from '../stores/mode.svelte';
  import { project } from '../stores/project.svelte';
  import { player } from '../stores/player.svelte';
  import { clamp, fmtHuman } from '../utils';
  import type { Mode } from '../types';

  const MODES: Mode[] = ['ingest', 'cut', 'polish', 'export'];

  const pct = $derived(project.durationSec ? (project.cutSec / project.durationSec) * 100 : 0);
</script>

<header
  class="flex h-12 shrink-0 items-center gap-3 border-b border-nc-line bg-nc-panel px-3 select-none"
>
  <!-- Brand -->
  <div class="flex items-center gap-2">
    <span
      class="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-nc-gold to-nc-gold-dim font-bold text-nc-bg"
      >7</span
    >
    <span class="text-sm font-bold tracking-tight">Nanami Cut</span>
    <span class="rounded bg-nc-panel-2 px-1.5 py-0.5 text-[10px] text-nc-mut">NO OVERTIME</span>
  </div>

  <!-- Mode chips -->
  <nav class="ml-3 flex items-center gap-1">
    {#each MODES as m, i (m)}
      <button
        onclick={() => mode.set(m)}
        class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors
               {mode.current === m
          ? 'bg-nc-gold text-nc-bg'
          : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
        title="Switch mode (destroys previous mode's RAM)"
      >
        {MODE_LABEL[m]}
      </button>
      {#if i < MODES.length - 1}
        <span class="text-nc-line-2 text-[10px]">›</span>
      {/if}
    {/each}
  </nav>

  <div class="flex-1"></div>

  <!-- Psychology #1: Overtime Saved counter -->
  <div
    class="mr-3 flex items-center gap-2 rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-1"
    title="Psychology: gamified counter. Every cut gives you dopamine."
  >
    <span class="text-[10px] tracking-widest text-nc-mut">RAW</span>
    <span class="font-mono text-xs text-nc-mut-2 line-through">{fmtHuman(project.durationSec)}</span
    >
    <span class="text-nc-gold">→</span>
    <span class="text-[10px] tracking-widest text-nc-mut">FINAL</span>
    <span class="font-mono text-xs font-bold text-nc-txt">{fmtHuman(project.keptSec)}</span>
    <span
      class="ml-1 rounded bg-nc-gold/15 px-1.5 py-0.5 font-mono text-[11px] font-bold text-nc-gold"
    >
      🔥 {fmtHuman(project.cutSec)} CUT ({pct.toFixed(0)}%)
    </span>
    <span class="h-1.5 w-16 overflow-hidden rounded-full bg-nc-line">
      <span
        class="block h-full rounded-full bg-gradient-to-r from-nc-gold to-nc-red transition-[width] duration-300"
        style="width:{clamp(pct, 0, 100)}%"
      ></span>
    </span>
  </div>

  <!-- Transport readout -->
  <div class="mr-2 font-mono text-xs text-nc-mut">
    <span class="text-nc-txt">{player.currentTime.toFixed(2)}s</span>
    <span class="text-nc-mut-2"> / {project.durationSec.toFixed(0)}s</span>
  </div>

  <button
    onclick={() => project.undo()}
    disabled={project.past.length === 0}
    class="rounded-md p-1.5 text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-30"
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
    class="rounded-md p-1.5 text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-30"
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

  <div
    class="grid h-7 w-7 place-items-center rounded-full border border-nc-line-2 bg-nc-panel-2 text-[10px] font-bold"
  >
    TD
  </div>
</header>
