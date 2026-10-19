<script lang="ts">
  /**
   * Export mode panel — simple by default, technical on demand.
   *
   * Top section answers the four questions every editor asks:
   *   Quality · Format · Name · Where to save
   * then a single Export button runs the whole render.
   *
   * The deep stuff (mode radio, plan breakdown, warnings) folds into an
   * "Advanced" details block so a first-time user never has to see it.
   */
  import { onMount } from "svelte";
  import { project } from "../../stores/project.svelte";
  import { exportStore } from "../../stores/export.svelte";
  import { save } from "@tauri-apps/plugin-dialog";
  import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
  import { formatBytes } from "../../stores/project.svelte";

  onMount(() => {
    exportStore.prepare();
  });

  const QUALITIES: Array<{
    value: "original" | "high" | "balanced" | "small";
    label: string;
    hint: string;
  }> = [
    {
      value: "original",
      label: "Original (near-lossless)",
      hint: "Largest file, visually identical to source",
    },
    { value: "high", label: "High (recommended)", hint: "Great quality, sensible file size" },
    { value: "balanced", label: "Balanced", hint: "Smaller file, slight quality trade-off" },
    { value: "small", label: "Small", hint: "Smallest file, for quick sharing" },
  ];

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

  async function pickFolder() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, title: "Choose save folder" });
    if (typeof dir === "string") exportStore.setOutputFolder(dir);
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
      // Reveal in Explorer (highlights the file) rather than opening the video.
      await revealItemInDir(exportStore.result.output);
    } catch {
      try {
        await openPath(exportStore.outputFolder);
      } catch {
        // ignore — best effort
      }
    }
  }

  /** One-click export: plan (if needed) then run. */
  async function exportNow() {
    if (exportStore.segments.length === 0 || !exportStore.outputPath) return;
    if (!exportStore.currentPlan) {
      await exportStore.buildPlan();
      if (exportStore.status === "error") return;
    }
    await exportStore.run();
  }
</script>

<div class="flex flex-col gap-3 h-full overflow-y-auto p-3">
  <!-- Source summary -->
  <div class="cc-panel p-3">
    <div class="flex items-center justify-between mb-2">
      <span class="cc-label">Source</span>
      {#if project.info}
        <span
          class="mono text-[11px] text-cc-text-3 truncate max-w-[55%]"
          title={project.info.path}
        >
          {project.info.path.split(/[\\/]/).pop()}
        </span>
      {/if}
    </div>
    <div class="flex flex-wrap gap-2 text-[12px]">
      <span class="cc-sub">
        {project.info ? `${project.info.width}x${project.info.height}` : "—"}
        · {project.info ? formatTime(project.info.durationSecs) : "—"}
        · {project.info ? formatBytes(project.info.sizeBytes) : "—"}
      </span>
    </div>
    <!-- Kept / cut summary -->
    <div class="flex flex-wrap gap-2 mt-2 text-[11px]">
      <span class="rounded bg-green-50 px-2 py-1 font-medium text-green-800">
        {exportStore.summary.segmentCount} kept segment(s)
      </span>
      <span class="rounded bg-emerald-50 px-2 py-1 font-medium text-emerald-800">
        {formatTime(exportStore.summary.keptSecs)}
      </span>
      <span class="rounded bg-rose-50 px-2 py-1 font-medium text-rose-800">
        cut {formatTime(exportStore.summary.cutSecs)}
      </span>
    </div>
  </div>

  <!-- Quality -->
  <div class="cc-panel p-3">
    <label class="cc-label" for="export-quality">Quality</label>
    <select
      id="export-quality"
      class="mt-1.5 w-full rounded border border-cc-line bg-cc-surface px-2 py-1.5 text-[12px] text-cc-text"
      bind:value={exportStore.quality}
      disabled={exportStore.status === "running"}
    >
      {#each QUALITIES as q (q.value)}
        <option value={q.value}>{q.label}</option>
      {/each}
    </select>
    <p class="mt-1 text-[10.5px] text-cc-text-3">
      {QUALITIES.find((q) => q.value === exportStore.quality)?.hint}
    </p>
  </div>

  <!-- Format + Name + Folder -->
  <div class="cc-panel p-3">
    <span class="cc-label">Output</span>
    <div class="mt-1.5 flex gap-2">
      <select
        class="w-24 shrink-0 rounded border border-cc-line bg-cc-surface px-2 py-1.5 text-[12px] text-cc-text"
        value={exportStore.outputExt}
        onchange={(e) => exportStore.setFormat(e.currentTarget.value === "mkv" ? "mkv" : "mp4")}
        disabled={exportStore.status === "running"}
      >
        <option value="mp4">MP4</option>
        <option value="mkv">MKV</option>
      </select>
      <input
        type="text"
        class="min-w-0 flex-1 rounded border border-cc-line bg-cc-surface px-2 py-1.5 text-[12px] text-cc-text"
        value={exportStore.outputName}
        oninput={(e) => exportStore.setOutputName(e.currentTarget.value)}
        placeholder="file name"
        disabled={exportStore.status === "running"}
      />
    </div>
    <div class="mt-2 flex gap-2">
      <input
        type="text"
        class="min-w-0 flex-1 rounded border border-cc-line bg-cc-surface px-2 py-1.5 text-[11px] text-cc-text-3"
        value={exportStore.outputFolder}
        oninput={(e) => exportStore.setOutputFolder(e.currentTarget.value)}
        placeholder="save folder…"
        disabled={exportStore.status === "running"}
      />
      <button
        type="button"
        class="cc-btn shrink-0 text-[11px]"
        onclick={pickFolder}
        disabled={exportStore.status === "running"}
      >
        Browse…
      </button>
    </div>
  </div>

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
      <button
        type="button"
        class="cc-btn cc-btn-primary w-full text-[13px]"
        onclick={exportNow}
        disabled={exportStore.segments.length === 0 ||
          !exportStore.outputPath ||
          exportStore.status === "planning"}
      >
        {exportStore.status === "planning" ? "Preparing…" : "Export Video"}
      </button>
      {#if exportStore.segments.length === 0}
        <p class="text-center text-[11px] text-cc-text-3">
          Transcribe and mark segments first — nothing to export yet.
        </p>
      {/if}
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
        <span>piece {exportStore.progress.pieceIndex} / {exportStore.progress.pieceCount}</span>
      </div>
    </div>
  {/if}

  <!-- Result -->
  {#if exportStore.status === "done" && exportStore.result}
    <div class="cc-panel p-3 border-l-4 border-emerald-500 bg-emerald-50">
      <div class="flex items-center justify-between mb-2">
        <span class="cc-label text-emerald-800">Export Complete ✓</span>
        <button type="button" class="cc-btn text-[11px]" onclick={openOutputFolder}>
          Open Folder
        </button>
      </div>
      <div class="grid grid-cols-2 gap-1 text-[11px]">
        <div>
          <span class="text-cc-text-3">Duration:</span>
          <span class="font-mono ml-1">{formatTime(exportStore.result.durationSecs)}</span>
        </div>
        <div>
          <span class="text-cc-text-3">Size:</span>
          <span class="font-mono ml-1">{formatBytes(exportStore.result.sizeBytes)}</span>
        </div>
      </div>
    </div>
  {/if}

  {#if exportStore.status === "cancelled"}
    <div class="cc-panel p-3 border-l-4 border-amber-500 bg-amber-50 text-amber-800 text-[11px]">
      Export cancelled.
    </div>
  {/if}

  <!-- Advanced (collapsed by default) -->
  <details class="cc-panel p-3">
    <summary class="cc-label cursor-pointer select-none">Advanced settings</summary>

    <!-- Export mode -->
    <fieldset class="mt-2">
      <legend class="text-[11px] font-semibold text-cc-text-2">Export mode</legend>
      <div class="space-y-2 mt-1.5">
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

    {#if exportStore.currentPlan}
      <div class="mt-3 border-l-4 border-cc-purple pl-2">
        <div class="text-[11px] font-semibold text-cc-text-2">Export plan</div>
        <div class="grid grid-cols-2 gap-1 text-[10.5px] mt-1">
          <div>
            <span class="text-cc-text-3">Pieces:</span>
            <span class="font-mono">{exportStore.currentPlan.pieces.length}</span>
          </div>
          <div>
            <span class="text-cc-text-3">Duration:</span>
            <span class="font-mono">{formatTime(exportStore.currentPlan.outputDurationSecs)}</span>
          </div>
          <div>
            <span class="text-cc-text-3">Stream-copy:</span>
            <span class="font-mono text-green-700">{exportStore.currentPlan.copyPieces}</span>
          </div>
          <div>
            <span class="text-cc-text-3">Re-encode:</span>
            <span class="font-mono text-amber-700">{exportStore.currentPlan.encodePieces}</span>
          </div>
          {#if exportStore.currentPlan.encoder}
            <div class="col-span-2">
              <span class="text-cc-text-3">Encoder:</span>
              <span class="font-mono">{exportStore.currentPlan.encoder}</span>
            </div>
          {/if}
        </div>
        {#if exportStore.currentPlan.warnings.length > 0}
          <details class="mt-2 text-[10px] text-amber-700 bg-amber-50 rounded p-2">
            <summary class="cursor-pointer font-medium"
              >Warnings ({exportStore.currentPlan.warnings.length})</summary
            >
            <ul class="mt-1 space-y-0.5 pl-4 list-disc">
              {#each exportStore.currentPlan.warnings as w}
                <li>{w}</li>
              {/each}
            </ul>
          </details>
        {/if}
        <details class="mt-2 text-[10px] text-cc-text-3">
          <summary class="cursor-pointer">piece breakdown</summary>
          <div class="mt-1 space-y-1 max-h-40 overflow-y-auto">
            {#each exportStore.currentPlan.pieces as piece (piece.index)}
              <div
                class="flex items-center gap-1.5 rounded px-2 py-1 {piece.kind === 'copy'
                  ? 'bg-green-50'
                  : 'bg-amber-50'}"
              >
                <span
                  class="rounded px-1.5 py-0.5 text-[9px] font-medium {piece.kind === 'copy'
                    ? 'bg-green-100 text-green-800'
                    : 'bg-amber-100 text-amber-800'}"
                >
                  {piece.kind === "copy" ? "✓ copy" : "⚙ encode"}
                </span>
                <span class="mono text-[10px]"
                  >{formatTime(piece.start)} → {formatTime(piece.end)}</span
                >
              </div>
            {/each}
          </div>
        </details>
      </div>
    {/if}
  </details>
</div>
