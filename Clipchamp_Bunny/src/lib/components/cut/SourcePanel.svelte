<script lang="ts">
  import { project } from '../../stores/project.svelte';
  import { media } from '../../stores/media.svelte';
  import { layout } from '../../stores/layout.svelte';
  import { thumbUrl } from '../../media';
  import { fmtSize } from '../../utils';

  /**
   * "My media" for the Cut mode — Clipchamp's left panel, but showing the
   * source clip of the current project instead of a separate library.
   * Collapsible (Ctrl+Alt+2), because the transcript panel is the real work surface.
   */
  const collapsed = $derived(layout.sourcePanelCollapsed);
  let fileInput: HTMLInputElement | null = $state(null);

  // Alt+I — open the file picker from anywhere
  $effect(() => {
    const open = () => fileInput?.click();
    window.addEventListener('t9:import', open);
    return () => window.removeEventListener('t9:import', open);
  });

  const asset = $derived(project.media);
  const strip = $derived(project.thumbnails);
  const poster = $derived(strip ? thumbUrl(strip, 0) : null);

  function onFiles(files: FileList | null) {
    if (!files?.length) return;
    const f = files[0];
    media.add(f, URL.createObjectURL(f));
    project.loadFile(f, URL.createObjectURL(f));
  }
</script>

<aside
  class="flex min-h-0 shrink-0 flex-col border-r border-nc-line bg-nc-panel
         {collapsed ? 'w-[44px]' : 'w-[200px]'}"
>
  <div class="flex h-10 shrink-0 items-center justify-between px-2.5">
    {#if !collapsed}
      <h2 class="text-[13px] font-semibold">My media</h2>
    {/if}
    <button
      onclick={() => (layout.sourcePanelCollapsed = !layout.sourcePanelCollapsed)}
      class="grid h-7 w-7 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
      title={collapsed ? 'Expand panel (Ctrl+Alt+2)' : 'Collapse panel (Ctrl+Alt+2)'}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
      >
        <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M9 5v14" />
      </svg>
    </button>
  </div>

  {#if !collapsed}
    <!-- Import media split button, directly under the panel head (Clipchamp order) -->
    <div class="px-2.5 pb-2.5">
      <div class="flex">
        <button
          onclick={() => fileInput?.click()}
          class="flex flex-1 items-center justify-center gap-1.5 rounded-l-md bg-nc-gold py-1.5 text-[12px] font-semibold text-nc-bg hover:brightness-110"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
          </svg>
          Import media
        </button>
        <button
          onclick={() => fileInput?.click()}
          class="grid w-6 place-items-center rounded-r-md bg-nc-gold-dim text-nc-bg hover:brightness-110"
          title="Import options"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </button>
      </div>
      <input
        bind:this={fileInput}
        type="file"
        accept="video/*,audio/*"
        class="hidden"
        onchange={(e) => {
          onFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
    </div>

    <div class="nc-scroll min-h-0 flex-1 px-2.5 pb-3" role="listbox" aria-label="Content sidebar">
      {#if asset}
        <div
          class="group relative"
          role="option"
          aria-selected="true"
          aria-label="{asset.name}, {asset.durationSecs.toFixed(0)} seconds, Added to this video"
        >
          <div
            class="relative aspect-video overflow-hidden rounded-md border border-nc-line bg-nc-bg"
          >
            {#if poster}
              <img src={poster} alt="" class="h-full w-full object-cover" />
            {:else}
              <div class="grid h-full w-full place-items-center text-nc-mut-2">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                >
                  <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9l5 3-5 3z" />
                </svg>
              </div>
            {/if}
            <span
              class="absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[9px] text-white"
            >
              {Math.floor(asset.durationSecs / 60)}:{String(
                Math.floor(asset.durationSecs % 60)
              ).padStart(2, '0')}
            </span>
          </div>
          <div class="mt-1 flex items-start gap-1">
            <span
              class="min-w-0 flex-1 truncate text-[10px] leading-4 text-nc-mut"
              title={asset.name}
            >
              {asset.name}
            </span>
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
          </div>
          <p class="mt-0.5 font-mono text-[9px] text-nc-mut-2">
            {asset.width}×{asset.height} · {asset.fps}fps · {fmtSize(asset.sizeBytes)}
          </p>
        </div>
      {/if}
    </div>
  {/if}
</aside>
