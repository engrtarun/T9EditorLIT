<script lang="ts">
  import { editor } from "$lib/editor.svelte";
  import { lookToFfmpeg } from "$lib/timeline";

  const e = $derived(editor.exportSettings);
  const approxMb = $derived(((e.videoKbps + e.audioKbps) * editor.durationSecs) / 8 / 1024);

  const filters = $derived(lookToFfmpeg(editor.look));

  /** Preview of the command line the Rust side will actually spawn. */
  const command = $derived(
    [
      "ffmpeg -y",
      `-i "<source>"`,
      `-vf "${filters || "null"}"`,
      `-c:v ${e.codec === "hevc" ? "libx265" : e.codec === "vp9" ? "libvpx-vp9" : "libx264"}`,
      e.preferHardware ? "-c:v h264_qsv" : "",
      `-b:v ${e.videoKbps}k`,
      `-c:a aac -b:a ${e.audioKbps}k`,
      `-r ${e.fps}`,
      `"<output>.${e.container}"`,
    ]
      .filter(Boolean)
      .join(" "),
  );
</script>

<section class="flex min-h-0 flex-1 flex-col bg-panel">
  <div class="flex h-9 shrink-0 items-center border-b border-panel-border px-3">
    <h2 class="text-xs font-medium text-zinc-300">Export</h2>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto p-4">
    <div class="mx-auto max-w-2xl">
      <div class="grid grid-cols-4 gap-3">
        {#each [["Width", e.width], ["Height", e.height], ["FPS", e.fps], ["Est. size", `${approxMb.toFixed(1)} MB`]] as [label, value] (label)}
          <div class="rounded bg-panel-raised p-2.5">
            <p class="text-[10px] tracking-wide text-zinc-500 uppercase">{label}</p>
            <p class="mt-0.5 font-mono text-sm text-zinc-100 tabular-nums">{value}</p>
          </div>
        {/each}
      </div>

      <div class="mt-4 rounded bg-black/40 p-3">
        <p class="mb-1.5 text-[10px] tracking-wide text-zinc-600 uppercase">
          FFmpeg command (preview)
        </p>
        <code class="block break-all text-[11px] leading-relaxed text-emerald-400/90"
          >{command}</code
        >
      </div>

      {#if editor.clips.length === 0}
        <p
          class="mt-4 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300"
        >
          Nothing on the timeline — add a clip before exporting.
        </p>
      {:else}
        <button
          type="button"
          class="mt-4 w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-zinc-950 hover:opacity-90"
          onclick={() => (editor.mode = "edit")}
        >
          Render {editor.clips.length} clip{editor.clips.length === 1 ? "" : "s"}
          ({editor.durationSecs.toFixed(1)}s)
        </button>
      {/if}

      <p class="mt-3 text-[10px] leading-relaxed text-zinc-600">
        Rendering is not wired up in the scaffold. The Rust side shells out to a short-lived FFmpeg
        child process and kills it immediately — no frames are ever buffered in the heap (see
        AGENTS.md).
      </p>
    </div>
  </div>
</section>
