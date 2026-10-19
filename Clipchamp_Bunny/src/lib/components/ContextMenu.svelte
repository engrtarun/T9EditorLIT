<script lang="ts">
  import type { MenuItem } from '../types';
  import MenuIcon from './MenuIcon.svelte';

  /**
   * Fluent-style popover menu — matches Clipchamp's `fui-MenuPopover`:
   * bg #1E1E29 · radius 4px · 1px transparent stroke · shadow16 · 4px padding
   * items min-height 32px · 20px icon · 14px text
   */
  let {
    items = [],
    x = 0,
    y = 0,
    onchoose = (_id: string) => {},
    onclose = () => {}
  }: {
    items: MenuItem[];
    x?: number;
    y?: number;
    onchoose?: (id: string) => void;
    onclose?: () => void;
  } = $props();

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onclose();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div
  class="fixed z-[300] min-w-[224px] max-w-[300px] rounded-md border border-nc-line-2 bg-[#1E1E29] p-1 shadow-2xl"
  style="left:{x}px;top:{y}px"
  role="menu"
>
  {#each items as it (it.id)}
    {#if it.divider}
      <div class="my-1 h-px bg-nc-line-2"></div>
    {:else}
      <button
        role="menuitem"
        disabled={it.disabled}
        onclick={() => onchoose(it.id)}
        class="flex w-full items-start gap-1.5 rounded px-2 py-1 text-left text-[13px] leading-5 transition-colors
               disabled:pointer-events-none disabled:opacity-40
               {it.danger ? 'text-nc-red hover:bg-nc-red/10' : 'text-nc-txt hover:bg-nc-panel-2'}"
      >
        {#if it.icon}
          <span class="mt-0.5 shrink-0 text-nc-mut"><MenuIcon name={it.icon} /></span>
        {/if}
        <span class="min-w-0 flex-1">
          <span class="block truncate">{it.label}</span>
          {#if it.secondary}
            <span class="block truncate text-[10px] text-nc-mut-2">{it.secondary}</span>
          {/if}
        </span>
      </button>
    {/if}
  {/each}
</div>
