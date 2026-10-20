<script lang="ts">
  import type { MenuItem } from '../types';
  import MenuIcon from './MenuIcon.svelte';

  /**
   * Fluent-style popover menu — matches Clipchamp's `fui-MenuPopover`:
   * bg #1E1E29 · radius 4px · 1px transparent stroke · shadow16 · 4px padding
   * items min-height 32px · 20px icon · 14px text
   *
   * It carries its own click-away catcher, so it always closes when you click
   * somewhere else. It is rendered at the app root (see `stores/menu.svelte.ts`)
   * so no ancestor stacking context can hide it.
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

  /**
   * Keep the menu on screen when it would overflow the viewport.
   *
   * Horizontally it slides back inside the right edge; vertically it is
   * nudged up when there is not enough room below the anchor — a card's
   * "more" button near the bottom of the list used to push the menu off the
   * window.
   */
  const pos = $derived.by(() => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
    const MENU_W = 300;
    const MENU_H = 320;
    const EDGE = 8;

    const left = Math.max(EDGE, Math.min(x, vw - EDGE - MENU_W));
    const below = y;
    const top =
      below + MENU_H > vh - EDGE ? Math.max(EDGE, Math.min(below, vh - EDGE - MENU_H)) : below;
    return { left, top };
  });
</script>

<svelte:window onkeydown={onKey} />

<!-- click-away catcher -->
<button class="fixed inset-0 z-[290] cursor-default" aria-label="Close menu" onclick={onclose}
></button>

<div
  class="fixed z-[300] max-h-[min(320px,70vh)] min-w-[224px] max-w-[300px] overflow-y-auto rounded-md border border-nc-line-2 bg-[#1E1E29] p-1 shadow-2xl"
  style="left:{pos.left}px;top:{pos.top}px"
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
