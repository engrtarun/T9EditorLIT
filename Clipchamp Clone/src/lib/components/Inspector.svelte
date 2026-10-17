<script lang="ts">
  import { editor } from "$lib/editor.svelte";
  import { clipEnd, lookToFfmpeg } from "$lib/timeline";
  import { neutralLook, type LookAdjustments, type TransitionKind } from "$lib/types";

  const TRANSITIONS: ReadonlyArray<{ id: TransitionKind; label: string }> = [
    { id: "crossfade", label: "Crossfade" },
    { id: "dissolve", label: "Dissolve" },
    { id: "dip_to_black", label: "Dip to black" },
    { id: "wipe", label: "Wipe" },
  ];

  type Slider = {
    key: keyof LookAdjustments;
    label: string;
    min: number;
    max: number;
    step: number;
  };

  const LOOK_SLIDERS: ReadonlyArray<Slider> = [
    { key: "brightness", label: "Brightness", min: -0.5, max: 0.5, step: 0.01 },
    { key: "contrast", label: "Contrast", min: -1, max: 1, step: 0.01 },
    { key: "saturation", label: "Saturation", min: -1, max: 1, step: 0.01 },
    { key: "temperature", label: "Temperature", min: -1, max: 1, step: 0.01 },
    { key: "tint", label: "Tint", min: -1, max: 1, step: 0.01 },
    { key: "vignette", label: "Vignette", min: 0, max: 1, step: 0.01 },
  ];

  const filterChain = $derived(lookToFfmpeg(editor.look));
  const clip = $derived(editor.selectedClip);
</script>

<aside class="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-panel-border bg-panel">
  <!-- Clip properties -->
  <section class="border-b border-panel-border p-3">
    <h2 class="mb-2 text-xs font-medium text-zinc-300">Clip</h2>

    {#if !clip}
      <p class="text-[11px] text-zinc-600">Select a clip on the timeline.</p>
    {:else}
      {@const asset = editor.assetById(clip.assetId)}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <dt class="text-zinc-500">Source</dt>
        <dd class="truncate text-zinc-300">{asset?.path.split(/[\\/]/).pop() ?? clip.assetId}</dd>
        <dt class="text-zinc-500">Start</dt>
        <dd class="font-mono text-zinc-300 tabular-nums">{clip.startSecs.toFixed(2)}s</dd>
        <dt class="text-zinc-500">End</dt>
        <dd class="font-mono text-zinc-300 tabular-nums">{clipEnd(clip).toFixed(2)}s</dd>
        <dt class="text-zinc-500">In / Out</dt>
        <dd class="font-mono text-zinc-300 tabular-nums">
          {clip.inPointSecs.toFixed(2)} / {clip.outPointSecs.toFixed(2)}
        </dd>
      </dl>

      <div class="mt-3 grid grid-cols-2 gap-2">
        <label class="flex flex-col gap-1 text-[10px] text-zinc-500">
          Speed
          <input
            type="number"
            min="0.25"
            max="4"
            step="0.25"
            value={clip.speed}
            onchange={(e) => editor.patchSelected({ speed: Number(e.currentTarget.value) || 1 })}
            class="rounded border border-panel-border bg-panel-raised px-1.5 py-1 text-xs text-zinc-100"
          />
        </label>
        <label class="flex flex-col gap-1 text-[10px] text-zinc-500">
          Volume
          <input
            type="number"
            min="0"
            max="2"
            step="0.05"
            value={clip.volume}
            onchange={(e) => editor.patchSelected({ volume: Number(e.currentTarget.value) ?? 1 })}
            class="rounded border border-panel-border bg-panel-raised px-1.5 py-1 text-xs text-zinc-100"
          />
        </label>
      </div>

      <label class="mt-2 flex flex-col gap-1 text-[10px] text-zinc-500">
        Transition
        <select
          value={clip.transition ?? ""}
          onchange={(e) =>
            editor.patchSelected({
              transition: (e.currentTarget.value || null) as TransitionKind | null,
            })}
          class="rounded border border-panel-border bg-panel-raised px-1.5 py-1 text-xs text-zinc-100"
        >
          <option value="">None</option>
          {#each TRANSITIONS as t (t.id)}
            <option value={t.id}>{t.label}</option>
          {/each}
        </select>
      </label>

      <div class="mt-3 flex gap-2">
        <button
          type="button"
          class="flex-1 rounded border border-panel-border px-2 py-1 text-[11px] text-zinc-400 hover:bg-panel-raised"
          onclick={() => editor.patchSelected({ muted: !clip.muted })}
        >
          {clip.muted ? "Unmute clip" : "Mute clip"}
        </button>
        <button
          type="button"
          class="rounded border border-panel-border px-2 py-1 text-[11px] text-zinc-400 hover:bg-panel-raised"
          onclick={() => editor.deleteSelected(false)}
          title="Delete clip, leave gap"
        >
          Delete
        </button>
      </div>
    {/if}
  </section>

  <!-- Look / filter pipeline -->
  <section class="border-b border-panel-border p-3">
    <div class="mb-2 flex items-center justify-between">
      <h2 class="text-xs font-medium text-zinc-300">Adjust</h2>
      <button
        type="button"
        class="text-[10px] text-zinc-500 hover:text-zinc-300"
        onclick={() => (editor.look = neutralLook())}
      >
        Reset
      </button>
    </div>

    <div class="flex flex-col gap-2">
      {#each LOOK_SLIDERS as s (s.key)}
        <label class="grid grid-cols-[68px_1fr_38px] items-center gap-2 text-[11px] text-zinc-500">
          <span>{s.label}</span>
          <input
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            value={editor.look[s.key]}
            oninput={(e) =>
              (editor.look = { ...editor.look, [s.key]: Number(e.currentTarget.value) })}
            class="accent-[var(--color-accent)]"
            aria-label={s.label}
          />
          <span class="text-right font-mono text-zinc-400 tabular-nums">
            {editor.look[s.key].toFixed(2)}
          </span>
        </label>
      {/each}
    </div>

    <!-- Shows exactly what FFmpeg will be asked to do. -->
    <div class="mt-3 rounded bg-black/40 p-2">
      <p class="mb-1 text-[9px] tracking-wide text-zinc-600 uppercase">ffmpeg -vf</p>
      <code class="block break-all text-[10px] leading-relaxed text-emerald-400/90">
        {filterChain || "(no filter — passthrough)"}
      </code>
    </div>
  </section>

  <!-- Export -->
  <section class="p-3">
    <h2 class="mb-2 text-xs font-medium text-zinc-300">Export</h2>
    <div class="grid grid-cols-2 gap-2">
      <div class="flex flex-col gap-1 text-[10px] text-zinc-500">
        Resolution
        <span class="font-mono text-zinc-400">
          {editor.exportSettings.width}×{editor.exportSettings.height}
        </span>
      </div>
      <label class="flex flex-col gap-1 text-[10px] text-zinc-500">
        FPS
        <select
          value={editor.exportSettings.fps}
          onchange={(e) =>
            (editor.exportSettings = {
              ...editor.exportSettings,
              fps: Number(e.currentTarget.value),
            })}
          class="rounded border border-panel-border bg-panel-raised px-1 py-0.5 text-[11px] text-zinc-100"
        >
          {#each [24, 25, 30, 60] as fps (fps)}
            <option value={fps}>{fps}</option>
          {/each}
        </select>
      </label>
      <label class="flex flex-col gap-1 text-[10px] text-zinc-500">
        Video kbps
        <input
          type="number"
          min="500"
          max="50000"
          step="500"
          value={editor.exportSettings.videoKbps}
          onchange={(e) =>
            (editor.exportSettings = {
              ...editor.exportSettings,
              videoKbps: Number(e.currentTarget.value),
            })}
          class="rounded border border-panel-border bg-panel-raised px-1.5 py-1 text-[11px] text-zinc-100"
        />
      </label>
      <label class="flex flex-col gap-1 text-[10px] text-zinc-500">
        Container
        <select
          value={editor.exportSettings.container}
          onchange={(e) =>
            (editor.exportSettings = {
              ...editor.exportSettings,
              container: e.currentTarget.value as typeof editor.exportSettings.container,
            })}
          class="rounded border border-panel-border bg-panel-raised px-1 py-0.5 text-[11px] text-zinc-100"
        >
          {#each ["mp4", "mov", "webm"] as c (c)}
            <option value={c}>{c}</option>
          {/each}
        </select>
      </label>
    </div>

    <label class="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
      <input
        type="checkbox"
        checked={editor.exportSettings.preferHardware}
        onchange={(e) =>
          (editor.exportSettings = {
            ...editor.exportSettings,
            preferHardware: e.currentTarget.checked,
          })}
        class="accent-[var(--color-accent)]"
      />
      Prefer hardware encoder (QSV)
    </label>
  </section>
</aside>
