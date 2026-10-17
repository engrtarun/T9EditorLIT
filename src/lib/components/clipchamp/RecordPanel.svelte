<script lang="ts">
  /**
   * "Record & create" panel.
   *
   * The four record sources and the text-to-speech tile are the layout copy
   * from the REA capture; the buttons are inert until the capture pipeline
   * (Chunk 3/5) wires them to FFmpeg's dshow/gdigrab inputs. They are real
   * <button>s with titles rather than divs so the affordance and a11y tree
   * already match the reference.
   */
  const RECORD = [
    { id: "screen-camera", label: "Screen and camera" },
    { id: "camera", label: "Camera" },
    { id: "screen", label: "Screen" },
    { id: "audio", label: "Audio" },
  ];
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
  <div class="cc-label">Record</div>

  <div class="flex flex-col gap-2">
    {#each RECORD as item (item.id)}
      <button
        type="button"
        class="relative flex h-14 items-center overflow-hidden rounded-md px-3 text-left
          text-[12.5px] font-semibold text-white"
        style="background: linear-gradient(100deg, var(--color-cc-purple-2), var(--color-cc-purple-3))"
        title="{item.label} — wiring lands with the capture chunk"
      >
        {item.label}
        <span class="absolute right-3 top-1/2 h-8 w-11 -translate-y-1/2 rounded bg-white/25"></span>
      </button>
    {/each}
  </div>

  <div class="cc-label mt-1">Create</div>

  <button
    type="button"
    class="relative flex h-14 items-center overflow-hidden rounded-md px-3 text-left
      text-[12.5px] font-semibold text-white"
    style="background: linear-gradient(100deg, var(--color-cc-purple), #4f6bf5)"
    title="Text to speech — voices arrive with the cloud chunk"
  >
    Text to speech
    <span class="absolute right-3 top-1/2 flex -translate-y-1/2 gap-0.5">
      {#each [6, 12, 8, 14, 5] as h (h)}
        <span class="w-0.5 rounded-full bg-white/70" style="height: {h}px"></span>
      {/each}
    </span>
  </button>
</div>
