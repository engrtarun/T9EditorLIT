<script lang="ts">
  /**
   * Stage — the centre surface: undo/redo, the floating Size toolbar, the
   * black 16:9 canvas, Share/Export.
   *
   * The canvas is the mount point for the real <video> (Chunk 3): it streams
   * from disk through the Tauri asset protocol, so a 5 GB source is never
   * buffered into RAM. Until then it carries the same empty-state promise the
   * original CutMode made about ffprobe.
   */
  import { project } from "../../stores/project.svelte";

  let { busy = false }: { busy?: boolean } = $props();
</script>

<section class="flex min-h-0 flex-1 flex-col" aria-label="Stage">
  <!-- Toolbar row -->
  <div class="flex h-12 shrink-0 items-center gap-2 px-3">
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-md text-cc-text-4
      hover:bg-cc-tint"
      title="Undo ctrl+z"
      disabled
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M8 7 4 11l4 4" />
        <path d="M4 11h9a6 6 0 0 1 0 12h-2" />
      </svg>
    </button>
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-md text-cc-text-4
      hover:bg-cc-tint"
      title="Redo ctrl+y"
      disabled
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m16 7 4 4-4 4" />
        <path d="M20 11h-9a6 6 0 0 0 0 12h2" />
      </svg>
    </button>

    <!-- Floating pill toolbar, centred over the canvas. -->
    <div
      class="mx-auto flex items-center gap-1 rounded-lg border border-cc-line bg-cc-surface
      px-1.5 py-1 shadow-sm"
    >
      <button
        type="button"
        class="flex items-center gap-1.5 rounded px-2.5 py-1 text-[12.5px]
        font-semibold text-cc-text hover:bg-cc-tint"
        title="Change aspect ratio"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          aria-hidden="true"
        >
          <path d="M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3" stroke-linecap="round" />
        </svg>
        Size ⌄
      </button>
      <span class="h-5 w-px bg-cc-line"></span>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded hover:bg-cc-tint"
        title="Background color"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 4h10l3 6-8 10-8-10z" fill="var(--color-cc-purple)" />
        </svg>
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded text-cc-text-3
        hover:bg-cc-tint"
        title="Add audio to use autocaptions"
        disabled
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          aria-hidden="true"
        >
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 12a7 7 0 0 0 14 0M12 19v2" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div class="flex items-center gap-2">
      <button type="button" class="cc-btn" title="Share">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="6" cy="12" r="2.5" />
          <circle cx="17" cy="6" r="2.5" />
          <circle cx="17" cy="18" r="2.5" />
          <path d="m8.3 10.8 6.4-3.6M8.3 13.2l6.4 3.6" />
        </svg>
        Share
      </button>
      <button
        type="button"
        class="cc-btn cc-btn-primary"
        disabled={!project.hasMedia || busy}
        title={project.hasMedia ? "Export via FFmpeg" : "Import media first"}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M12 19V5m0 0-5 5m5-5 5 5" />
        </svg>
        Export
      </button>
    </div>
  </div>

  <!-- Canvas -->
  <div class="flex min-h-0 flex-1 items-center justify-center px-6 pb-2">
    <div
      class="relative flex aspect-video max-h-full w-full max-w-[900px] items-center
      justify-center overflow-hidden rounded-sm bg-black"
    >
      <!--
        Chunk 3 mounts <video> here (asset-protocol URL, streamed from disk);
        ✕ segments are skipped on timeupdate — the Phantom Cut.
      -->
      {#if !project.hasMedia}
        <div class="flex flex-col items-center gap-2 p-6 text-center">
          <h2 class="text-[15px] font-semibold text-white/90">Load a source video to begin</h2>
          <p class="max-w-sm text-[12.5px] leading-relaxed text-white/55">
            Pick a recording up to 5&nbsp;GB from the <strong>My media</strong> panel — it is probed with
            ffprobe, never loaded into memory.
          </p>
        </div>
      {:else}
        <span class="mono text-[11px] text-white/50">preview streams from disk here</span>
      {/if}
    </div>
  </div>
</section>
