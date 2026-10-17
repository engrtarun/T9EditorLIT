<script lang="ts">
  import { editor } from "$lib/editor.svelte";
  import { formatTimecode } from "$lib/timeline";

  const { width, height } = $derived(editor.exportSettings);
</script>

<section class="flex min-h-0 flex-1 flex-col bg-zinc-900">
  <div class="relative grid min-h-0 flex-1 place-items-center p-4">
    <!--
      Canvas placeholder. Real playback is delegated to a WebView2 <video>
      driven from Rust; the scaffold shows the frame and aspect only.
    -->
    <div
      class="grid max-h-full w-full place-items-center rounded border border-panel-border bg-black shadow-lg"
      style="aspect-ratio: {width} / {height}; max-width: min(100%, calc((100% - 2rem) * {width} / {height}));"
    >
      <div class="text-center">
        <p class="text-2xl text-zinc-700">{width}×{height}</p>
        <p class="mt-1 text-[11px] text-zinc-600">
          {editor.clips.length} clip{editor.clips.length === 1 ? "" : "s"}
          · {formatTimecode(editor.durationSecs)}
        </p>
      </div>
    </div>
  </div>

  <!-- Transport -->
  <div class="flex h-11 shrink-0 items-center gap-3 border-t border-panel-border bg-panel px-4">
    <button
      type="button"
      class="grid size-7 place-items-center rounded-full bg-panel-raised text-zinc-300 hover:bg-zinc-700"
      onclick={() => editor.seek(0)}
      title="Go to start"
      aria-label="Go to start"
    >
      ⏮
    </button>
    <button
      type="button"
      class="grid size-8 place-items-center rounded-full bg-accent text-zinc-950 hover:opacity-90"
      onclick={() => editor.togglePlay()}
      title={editor.playing ? "Pause (Space)" : "Play (Space)"}
      aria-label={editor.playing ? "Pause" : "Play"}
    >
      {editor.playing ? "❚❚" : "▶"}
    </button>
    <button
      type="button"
      class="grid size-7 place-items-center rounded-full bg-panel-raised text-zinc-300 hover:bg-zinc-700"
      onclick={() => editor.seek(editor.durationSecs)}
      title="Go to end"
      aria-label="Go to end"
    >
      ⏭
    </button>

    <span class="font-mono text-xs text-zinc-400 tabular-nums">
      {formatTimecode(editor.playheadSecs)}
      <span class="text-zinc-600">/ {formatTimecode(editor.durationSecs)}</span>
    </span>

    <div class="ml-auto flex items-center gap-1">
      <button
        type="button"
        class="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-panel-raised disabled:opacity-40"
        disabled={!editor.selectedClip}
        onclick={() => editor.splitSelected()}
        title="Split selected clip at playhead (S)"
      >
        Split
      </button>
      <button
        type="button"
        class="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-panel-raised disabled:opacity-40"
        disabled={!editor.selectedClip}
        onclick={() => editor.deleteSelected(true)}
        title="Ripple delete selected clip (Shift+Del)"
      >
        Ripple cut
      </button>
    </div>
  </div>
</section>
