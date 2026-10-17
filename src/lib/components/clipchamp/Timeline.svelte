<script lang="ts">
  /**
   * Timeline — transport toolbar over the track area.
   *
   * The transport is dead until a source exists, exactly like the reference
   * (its buttons render disabled on an empty project too). The track area
   * carries the drop target; Chunk 3 fills it with the waveform canvas and
   * the FPS thumbnail strip, both rendered from FFmpeg-extracted data.
   */
  import { project } from "../../stores/project.svelte";
</script>

<section
  class="flex h-[168px] shrink-0 flex-col border-t border-cc-line bg-cc-surface"
  aria-label="Timeline"
>
  <!-- Transport -->
  <div class="flex h-11 shrink-0 items-center justify-center gap-1 border-b border-cc-line-soft">
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-cc-text-3
      hover:bg-cc-tint"
      title="Seek to start"
      disabled={!project.hasMedia}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M6 5h2v14H6zM19 5v14l-10-7z" />
      </svg>
    </button>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-cc-text-3
      hover:bg-cc-tint"
      title="Back 5 seconds shift+←"
      disabled={!project.hasMedia}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M11 6 5 12l6 6" />
        <path d="M19 6l-6 6 6 6" />
      </svg>
    </button>
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-full border
      border-cc-line text-cc-text hover:bg-cc-tint"
      title="Play SPACE"
      disabled={!project.hasMedia}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M7 4.5v15l13-7.5z" />
      </svg>
    </button>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-cc-text-3
      hover:bg-cc-tint"
      title="Forward 5 seconds shift+→"
      disabled={!project.hasMedia}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m13 6 6 6-6 6" />
        <path d="m5 6 6 6-6 6" />
      </svg>
    </button>
    <span class="mono ml-2 text-[12px] text-cc-text-3">
      {project.hasMedia ? project.durationLabel : "0:00.00"} / {project.hasMedia
        ? project.durationLabel
        : "0:00.00"}
    </span>
  </div>

  <!-- Track area -->
  <div class="relative min-h-0 flex-1 overflow-hidden p-3">
    <!--
      Chunk 3: multi-resolution amplitude peaks on a small canvas plus an
      ~1 fps thumbnail strip cached as JPEGs on disk. Nothing here buffers
      decoded frames in the heap.
    -->
    <div
      class="flex h-full items-center justify-center rounded-md border-2 border-dashed
      border-cc-line"
    >
      {#if project.hasMedia}
        <div class="flex w-full flex-col gap-1.5 px-4">
          <div class="h-9 w-full rounded bg-cc-tint"></div>
          <div class="mono text-center text-[10.5px] text-cc-text-3">
            waveform + thumbnail strip render here from extracted audio
          </div>
        </div>
      {:else}
        <span class="text-[12.5px] text-cc-text-3">Drag &amp; drop media here</span>
      {/if}
    </div>
  </div>
</section>
