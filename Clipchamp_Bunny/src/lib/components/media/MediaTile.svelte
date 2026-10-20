<script lang="ts">
  import type { MediaEntry } from '../../stores/media.svelte';
  import ContextMenu from '../ContextMenu.svelte';
  import type { MenuItem } from '../../types';

  /**
   * Clipchamp's media tile, 1:1 with the `asset` DOM:
   *   video-preview (opacity .6 while loading) · progress-bar + displayed-percentage
   *   add-asset-button (bottom-right, opacity 0 → hover) · More options (⋮, top-right)
   *   asset-title + in-use-checkmark
   */
  let {
    entry,
    renaming = false,
    onadd = (_id: string) => {},
    onmenu = (_id: string, _x: number, _y: number) => {},
    onrename = (_id: string, _name: string) => {}
  }: {
    entry: MediaEntry;
    renaming?: boolean;
    onadd?: (id: string) => void;
    onmenu?: (id: string, x: number, y: number) => void;
    onrename?: (id: string, name: string) => void;
  } = $props();

  const loading = $derived(entry.phase === 'loading');

  let draft = $state('');

  // Keep the draft in sync whenever rename mode is (re)entered.
  $effect(() => {
    if (renaming) draft = entry.asset.name;
  });

  function openMenu(e: MouseEvent) {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onmenu(entry.asset.id, Math.round(r.left - 180), Math.round(r.bottom + 4));
  }

  function commitRename() {
    const name = draft.trim();
    if (name && name !== entry.asset.name) onrename(entry.asset.id, name);
  }
</script>

<div
  class="group relative"
  role="option"
  aria-selected={entry.inUse}
  tabIndex={0}
  aria-label="{entry.asset.name}, {entry.durationLabel}, {entry.inUse
    ? 'Added to this video'
    : 'Not in this video'}"
>
  <div
    class="relative aspect-video overflow-hidden rounded-md border border-nc-line bg-nc-bg"
    style="border-radius:var(--nc-radius, 4px)"
  >
    <!-- video-preview -->
    {#if entry.asset.url}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        src={entry.asset.url}
        muted
        playsinline
        preload="metadata"
        class="h-full w-full object-cover"
        style="opacity:{loading ? 0.6 : 1}"
      ></video>
    {:else}
      <div class="grid h-full w-full place-items-center text-nc-mut-2">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        >
          <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3z" />
        </svg>
      </div>
    {/if}

    <!-- progress-bar + displayed-percentage -->
    {#if loading}
      <div class="absolute right-1.5 bottom-1.5 left-1.5">
        <span class="mb-1 block font-mono text-[9px] text-white/90">
          {Math.round(entry.progress * 100)}%
        </span>
        <div class="h-[3px] overflow-hidden rounded-full bg-white/25">
          <div
            class="h-full bg-white/90 transition-[width]"
            style="width:{entry.progress * 100}%"
          ></div>
        </div>
      </div>
    {/if}

    <!-- add-asset-button (bottom-right, on hover) -->
    <button
      onclick={() => onadd(entry.asset.id)}
      class="absolute right-1 bottom-1 grid h-6 w-6 place-items-center rounded bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-nc-gold hover:text-nc-bg"
      title="Add to timeline"
      aria-label="Add {entry.asset.name} to timeline"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>

    <!-- More options (top-right, on hover) -->
    <button
      onclick={openMenu}
      class="absolute top-1 right-1 grid h-6 w-6 place-items-center rounded bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-nc-panel-2"
      title="More options"
      aria-label="More options"
      aria-haspopup="menu"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle
          cx="19"
          cy="12"
          r="1.6"
        />
      </svg>
    </button>
  </div>

  <!-- asset-title + in-use-checkmark -->
  <div class="mt-1 flex items-start gap-1">
    {#if renaming}
      <input
        bind:value={draft}
        onblur={commitRename}
        onkeydown={(e) => {
          if (e.key === 'Enter') commitRename();
          if (e.key === 'Escape') draft = entry.asset.name;
        }}
        class="min-w-0 flex-1 rounded border border-nc-gold bg-nc-bg px-1 text-[10px] leading-4 text-nc-txt outline-none"
      />
    {:else}
      <span
        class="min-w-0 flex-1 truncate text-[10px] leading-4 text-nc-mut"
        title={entry.asset.name}
      >
        {entry.asset.name}
      </span>
    {/if}
    {#if entry.inUse && !renaming}
      <span
        class="mt-0.5 grid h-3 w-3 shrink-0 place-items-center rounded-full bg-nc-green/20 text-nc-green"
        title="Added to this video"
      >
        <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
          <path
            d="M1 6a5 5 0 1 1 10 0A5 5 0 0 1 1 6Zm7.35-.9a.5.5 0 1 0-.7-.7L5.5 6.54 4.35 5.4a.5.5 0 1 0-.7.7l1.5 1.5c.2.2.5.2.7 0l2.5-2.5Z"
          />
        </svg>
      </span>
    {/if}
  </div>
</div>
