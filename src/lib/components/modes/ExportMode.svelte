<script lang="ts">
  /**
   * Export mode panel — smart hybrid render with live progress.
   *
   * Shows the export plan (pieces, encoder, warnings) before running, then
   * streams progress events from the Rust backend. Never blocks the UI thread.
   */
  import { onMount } from "svelte";
  import { project } from "../../stores/project.svelte";
  import { exportStore } from "../../stores/export.svelte";
  import { open, save } from "@tauri-apps/plugin-dialog";
  import { openPath } from "@tauri-apps/plugin-opener";
  import { formatBytes } from "../../stores/project.svelte";
  import type { ExportProgress, ExportPiece } from "../../types";

  onMount(() => {
    exportStore.prepare();
  });

  const MODES: Array<{ value: "hybrid" | "copy" | "encode"; label: string; hint: string }> = [
    {
      value: "hybrid",
      label: "Smart Hybrid (default)",
      hint: "Stream-copy aligned cuts, micro-encode only the partial GOPs",
    },
    {
      value: "copy",
      label: "Stream Copy Only",
      hint: "Snap cuts to keyframes — zero quality loss, may drop short segments",
    },
    {
      value: "encode",
      label: "Full Re-Encode",
      hint: "Exact cut points, everything re-encoded — slowest, highest compatibility",
    },
  ];

  function formatTime(secs: number): string {
    if (!Number.isFinite(secs) || secs < 0) return "--:--";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs % 1) * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`;
    return `${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`;
  }

  function pieceKindBadge(kind: "copy" | "encode") {
    return kind === "copy"
      ? { text: "✓ copy", cls: "bg-green-100 text-green-800" }
      : { text: "⚙ encode", cls: "bg-amber-100 text-amber-800" };
  }

  async function pickOutput() {
    const path = await save({
      filters: [
        { name: "MP4 Video", extensions: ["mp4"] },
        { name: "Matroska Video", extensions: ["mkv"] },
      ],
      defaultPath: exportStore.outputPath,
    });
    if (path) exportStore.outputPath = path;
  }

  async function openOutputFolder() {
    if (!exportStore.result?.output) return;
    try {
      await openPath(exportStore.result.output);
    } catch {
      // ignore — best effort
    }
  }

  function planWarnings(): string[] {
    return exportStore.currentPlan?.warnings ?? [];
  }

  function hasWarnings(): boolean {
    return planWarnings().length > 0;
  }
</script>

<div class="flex flex-col gap-3 h-full overflow-y-auto p-3">
  <!-- Source summary -->
  <div class="cc-panel p-3">
    <div class="flex items-center justify-between mb-2">
      <span class="cc-label">Source</span>
      {#if project.info}
        <span class="mono text-[11px] text-cc-text-3">{project.info.path}</span>
      {/if}
    </div>
    <div class="flex flex-wrap gap-2 text-[12px]">
      <span class="cc-sub">
        {project.info ? `${project.info.width}x${project.info.height}` : "—"}
        · {project.info ? formatTime(project.info.durationSecs) : "—"}
        · {project.info ? formatBytes(project.info.sizeBytes) : "—"}
      </span>
    </div>
  </div>

  <!-- Segments summary -->
  <div class="cc-panel p-3">
    <span class="cc-label">Kept Segments</span>
    <div class="flex flex-wrap gap-2 mt-1.5">
      <span
        class="inline-flex items-center gap-1 rounded px-2 py-1 bg-green-50 text-green-800 text-[11px] font-medium"
      >
        {exportStore.summary.segmentCount} segment(s)
      </span>
      <span
        class="inline-flex items-center gap-1 rounded px-2 py-1 bg-emerald-50 text-emerald-800 text-[11px] font-medium"
      >
        kept {formatTime(exportStore.summary.keptSecs)}
      </span>
      <span
        class="inline-flex items-center gap-1 rounded px-2 py-1 bg-rose-50 text-rose-800 text-[11px] font-medium"
      >
        cut {formatTime(exportStore.summary.cutSecs)}
      </span>
    </div>
    {#if exportStore.segments.length > 0}
      <details class="mt-2 text-[11px] text-cc-text-3">
        <summary class="cursor-pointer">show segments</summary>
        <ul class="mt-1 space-y-0.5 pl-4">
          {#each exportStore.segments as seg (seg.start)}
            <li class="mono">
              {formatTime(seg.start)} → {formatTime(seg.end)} ({formatTime(seg.end - seg.start)})
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  </div>

  <!-- Export mode -->
  <fieldset class="cc-panel p-3">
    <legend class="cc-label">Export Mode</legend>
    <div class="space-y-2 mt-2">
      {#each MODES as m (m.value)}
        <label class="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="export-mode"
            value={m.value}
            bind:group={exportStore.mode}
            class="mt-1 accent-cc-purple"
          />
          <div>
            <div class="font-medium text-[12px] text-cc-text">{m.label}</div>
            <div class="text-[10px] text-cc-text-3">{m.hint}</div>
          </div>
        </label>
      {/each}
    </div>
  </fieldset>

  <!-- Output path -->
  <div class="cc-panel p-3">
    <div class="flex items-center justify-between mb-2">
      <span class="cc-label">Output</span>
      <button
        type="button"
        class="cc-btn text-[11px]"
        onclick={pickOutput}
        disabled={exportStore.status === "running"}
      >
        Browse…
      </button>
    </div>
    <input
      type="text"
      class="w-full rounded border border-cc-line bg-cc-surface px-2 py-1.5 text-[12px] text-cc-text"
      bind:value={exportStore.outputPath}
      placeholder="Choose output file…"
      disabled={exportStore.status === "running"}
    />
  </div>

  <!-- Plan preview -->
  {#if exportStore.currentPlan}
    <div class="cc-panel p-3 border-l-4 border-cc-purple">
      <div class="flex items-center justify-between mb-2">
        <span class="cc-label">Export Plan</span>
        <span class="text-[10px] text-cc-text-3">{exportStore.currentPlan.mode}</span>
      </div>

      <div class="grid grid-cols-2 gap-2 text-[11px] mb-2">
        <div>
          <span class="text-cc-text-3">Total pieces:</span>
          <span class="font-mono ml-1">{exportStore.currentPlan.pieces.length}</span>
        </div>
        <div>
          <span class="text-cc-text-3">Output duration:</span>
          <span class="font-mono ml-1"
            >{formatTime(exportStore.currentPlan.outputDurationSecs)}</span
          >
        </div>
        <div>
          <span class="text-cc-text-3">Stream-copy:</span>
          <span class="font-mono ml-1 text-green-700">{exportStore.currentPlan.copyPieces}</span>
        </div>
        <div>
          <span class="text-cc-text-3">Micro-encode:</span>
          <span class="font-mono ml-1 text-amber-700">{exportStore.currentPlan.encodePieces}</span>
        </div>
        {#if exportStore.currentPlan.encoder}
          <div class="col-span-2">
            <span class="text-cc-text-3">Encoder:</span>
            <span
              class="font-mono ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-cc-tint text-[10px]"
            >
              {exportStore.currentPlan.encoder}
            </span>
          </div>
        {/if}
        <div class="col-span-2">
          <span class="text-cc-text-3">Est. size:</span>
          <span class="font-mono ml-1"
            >{formatBytes(exportStore.currentPlan.estimatedSizeBytes)}</span
          >
        </div>
        <div class="col-span-2">
          <span class="text-cc-text-3">Keyframes:</span>
          <span class="font-mono ml-1">{exportStore.currentPlan.keyframeCount}</span>
        </div>
      </div>

      {#if hasWarnings()}
        <details class="text-[10px] text-amber-700 bg-amber-50 rounded p-2">
          <summary class="cursor-pointer font-medium">Warnings ({planWarnings().length})</summary>
          <ul class="mt-1 space-y-0.5 pl-4 list-disc">
            {#each planWarnings() as w}
              <li>{w}</li>
            {/each}
          </ul>
        </details>
      {/if}

      <details class="mt-2 text-[10px] text-cc-text-3">
        <summary class="cursor-pointer">show piece breakdown</summary>
        <div class="mt-1 space-y-1 max-h-48 overflow-y-auto">
          {#each exportStore.currentPlan.pieces as piece (piece.index)}
            {#if piece.kind === "copy"}
              <div class="flex items-center gap-1.5 rounded px-2 py-1 bg-green-50">
                <span
                  class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-green-100 text-green-800 text-[9px] font-medium"
                  >✓ copy</span
                >
                <span class="mono text-[10px]"
                  >{formatTime(piece.start)} → {formatTime(piece.end)}</span
                >
                <span class="text-[10px] text-cc-text-3">({formatTime(piece.durationSecs)})</span>
              </div>
            {:else}
              <div class="flex items-center gap-1.5 rounded px-2 py-1 bg-amber-50">
                <span
                  class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-amber-100 text-amber-800 text-[9px] font-medium"
                  >⚙ encode</span
                >
                <span class="mono text-[10px]"
                  >{formatTime(piece.start)} → {formatTime(piece.end)}</span
                >
                <span class="text-[10px] text-cc-text-3">({formatTime(piece.durationSecs)})</span>
              </div>
            {/if}
          {/each}
        </div>
      </details>
    </div>
  {/if}

  <!-- Actions -->
  <div class="flex flex-col gap-2">
    {#if exportStore.status === "running"}
      <button
        type="button"
        class="cc-btn cc-btn-primary w-full"
        onclick={() => exportStore.cancel()}
      >
        Cancel Export
      </button>
    {:else}
      <div class="flex gap-2">
        <button
          type="button"
          class="cc-btn flex-1"
          onclick={() => exportStore.buildPlan()}
          disabled={exportStore.segments.length === 0 || exportStore.status === "planning"}
        >
          {exportStore.status === "planning" ? "Planning…" : "Analyse"}
        </button>
        <button
          type="button"
          class="cc-btn cc-btn-primary flex-1"
          onclick={() => exportStore.run()}
          disabled={exportStore.segments.length === 0 || !exportStore.outputPath}
        >
          Start Export
        </button>
      </div>
    {/if}

    {#if exportStore.status === "error"}
      <div class="cc-panel p-3 bg-rose-50 border-rose-200 text-rose-800 text-[11px]">
        {exportStore.error}
      </div>
    {/if}
  </div>

  <!-- Progress -->
  {#if exportStore.status === "running" && exportStore.progress}
    <div class="cc-panel p-3">
      <div class="flex items-center justify-between mb-1.5">
        <span class="cc-label">Progress</span>
        <span class="mono text-[11px] text-cc-text-3"
          >{exportStore.progress.percent.toFixed(1)}%</span
        >
      </div>
      <div class="h-2 rounded-full bg-cc-line overflow-hidden">
        <div
          class="h-full rounded-full transition-all duration-150 bg-cc-purple"
          style="width: {exportStore.progress.percent}%"
        ></div>
      </div>
      <div class="mt-1 flex justify-between text-[10px] text-cc-text-3">
        <span>{exportStore.progress.stage} — {exportStore.progress.message}</span>
        <span>
          piece {exportStore.progress.pieceIndex} / {exportStore.progress.pieceCount}
        </span>
      </div>
    </div>
  {/if}

  <!-- Result -->
  {#if exportStore.status === "done" && exportStore.result}
    <div class="cc-panel p-3 border-l-4 border-emerald-500 bg-emerald-50">
      <div class="flex items-center justify-between mb-2">
        <span class="cc-label text-emerald-800">Export Complete</span>
        <button type="button" class="cc-btn text-[11px]" onclick={openOutputFolder}>
          Open Folder
        </button>
      </div>
      <div class="grid grid-cols-2 gap-1 text-[11px]">
        <div>
          <span class="text-cc-text-3">File:</span>
          <span class="font-mono ml-1 truncate block">{exportStore.result.output}</span>
        </div>
        <div>
          <span class="text-cc-text-3">Duration:</span>
          <span class="font-mono ml-1">{formatTime(exportStore.result.durationSecs)}</span>
        </div>
        <div>
          <span class="text-cc-text-3">Size:</span>
          <span class="font-mono ml-1">{formatBytes(exportStore.result.sizeBytes)}</span>
        </div>
        <div>
          <span class="text-cc-text-3">Pieces:</span>
          <span class="font-mono ml-1">{exportStore.result.pieceCount}</span>
        </div>
        {#if exportStore.result.encoder}
          <div class="col-span-2">
            <span class="text-cc-text-3">Encoder:</span>
            <span class="font-mono ml-1">{exportStore.result.encoder}</span>
          </div>
        {/if}
      </div>
      {#if exportStore.result.warnings.length > 0}
        <details class="mt-2 text-[10px] text-amber-700">
          <summary class="cursor-pointer font-medium"
            >Warnings ({exportStore.result.warnings.length})</summary
          >
          <ul class="mt-1 space-y-0.5 pl-4 list-disc">
            {#each exportStore.result.warnings as w}
              <li>{w}</li>
            {/each}
          </ul>
        </details>
      {/if}
    </div>
  {/if}

  {#if exportStore.status === "cancelled"}
    <div class="cc-panel p-3 border-l-4 border-amber-500 bg-amber-50 text-amber-800 text-[11px]">
      Export cancelled.
    </div>
  {/if}
</div>
