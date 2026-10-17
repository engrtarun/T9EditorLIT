<script lang="ts">
  /**
   * Mode 2 — Music & Text (Polish).
   *
   * Background music deck with sidechain auto-ducking under speech, plus a
   * text/title overlay. All rendering streams through FFmpeg child processes;
   * nothing large ever lives in this process's heap (AGENTS.md §1).
   */
  import { project } from "../../stores/project.svelte";
  import { mode } from "../../stores/mode.svelte";
  import { pickAudioFile, polishRender, errorMessage } from "../../ipc";
  import type { PolishSettings, TextPosition, PolishResult } from "../../types";

  const DEFAULT_SETTINGS: PolishSettings = {
    musicPath: null,
    musicVolume: 0.15,
    musicLoop: true,
    duckEnabled: true,
    duckDb: -14.0,
    duckAttackMs: 200.0,
    duckReleaseMs: 800.0,
    text: "",
    textPosition: "bottom-left",
  };

  let settings = $state<PolishSettings>({ ...DEFAULT_SETTINGS });
  let musicName = $state<string | null>(null);
  let rendering = $state(false);
  let renderError = $state<string | null>(null);
  let renderResult = $state<PolishResult | null>(null);

  async function pickMusic() {
    try {
      const path = await pickAudioFile();
      if (path) {
        settings.musicPath = path;
        musicName = path.split(/[\\/]/).pop() ?? path;
        renderError = null;
      }
    } catch (err) {
      renderError = errorMessage(err);
    }
  }

  function clearMusic() {
    settings.musicPath = null;
    musicName = null;
    renderError = null;
  }

  function setVolume(v: number) {
    settings.musicVolume = Math.max(0, Math.min(1, v / 100));
  }

  function setPosition(pos: TextPosition) {
    settings.textPosition = pos;
  }

  async function renderPolish() {
    if (!project.hasMedia || !project.info) {
      renderError = "Import a video first";
      return;
    }
    rendering = true;
    renderError = null;
    renderResult = null;
    try {
      const output = project.info.path.replace(/\.[^/.]+$/, "") + ".polished.mp4";
      const result = await polishRender(project.info.path, output, settings);
      renderResult = result;
    } catch (err) {
      renderError = errorMessage(err);
    } finally {
      rendering = false;
    }
  }

  function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  const POSITIONS: { id: TextPosition; label: string }[] = [
    { id: "bottom-left", label: "Bottom Left" },
    { id: "top-left", label: "Top Left" },
    { id: "center", label: "Center" },
  ];
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 p-3">
  <div class="flex items-center justify-between">
    <span class="cc-label">Polish — Music &amp; Text</span>
    <button type="button" class="cc-btn self-start text-[11px]" onclick={() => mode.set("cut")}>
      ← Back to Cut
    </button>
  </div>

  {#if !project.hasMedia}
    <div
      class="cc-panel flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
    >
      <span class="text-[12.5px] text-cc-text">Import a video first</span>
      <span class="text-[11px] text-cc-text-3"
        >Open a source in Cut mode, then come back here to polish.</span
      >
    </div>
  {:else}
    <!-- Music deck -->
    <section class="cc-panel flex min-h-0 flex-col gap-3 p-4">
      <div class="flex items-center justify-between">
        <h3 class="text-[14px] font-semibold text-cc-text">Background Music</h3>
        <span
          class="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px]
            {settings.musicPath ? 'bg-cc-keep text-cc-keep' : 'bg-cc-tint text-cc-text-3'}"
        >
          {settings.musicPath ? "loaded" : "none"}
        </span>
      </div>

      <div class="flex items-center gap-3">
        <button
          type="button"
          class="cc-btn flex-1 text-[12px]"
          disabled={rendering}
          onclick={pickMusic}
        >
          {settings.musicPath ? "Change Music" : "Pick Audio File"}
        </button>
        {#if settings.musicPath}
          <button
            type="button"
            class="cc-btn text-[11px] px-2 py-1 text-cc-cut hover:bg-cc-cut/10"
            onclick={clearMusic}
            title="Remove music"
          >
            ✕
          </button>
        {/if}
      </div>

      {#if musicName}
        <div class="flex items-center justify-between p-2 bg-cc-tint rounded text-[11px]">
          <span class="truncate text-cc-text">{musicName}</span>
          <span class="mono text-cc-text-3">{formatBytes(0)}</span>
        </div>
      {/if}

      <!-- Volume -->
      <div class="flex items-center gap-2">
        <span class="text-[12px] text-cc-text-2 shrink-0">Volume</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={settings.musicVolume * 100}
          class="w-full accent-cc-purple h-1.5 bg-cc-line rounded-lg cursor-pointer"
          oninput={(e) => setVolume(Number((e.target as HTMLInputElement).value))}
        />
        <span class="text-[11px] mono text-cc-text shrink-0">
          {Math.round(settings.musicVolume * 100)}%
        </span>
      </div>

      <!-- Loop -->
      <div class="flex items-center gap-2">
        <input
          type="checkbox"
          checked={settings.musicLoop}
          class="accent-cc-purple h-4 w-4 shrink-0"
          onchange={(e) => (settings.musicLoop = (e.target as HTMLInputElement).checked)}
        />
        <span class="text-[12px] text-cc-text">Loop music if shorter than video</span>
      </div>
    </section>

    <!-- Auto-ducking -->
    {#if settings.musicPath}
      <section class="cc-panel flex min-h-0 flex-col gap-3 p-4">
        <div class="flex items-center justify-between">
          <h3 class="text-[14px] font-semibold text-cc-text">Auto-Ducking</h3>
          <span
            class="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px]
              {settings.duckEnabled ? 'bg-cc-keep text-cc-keep' : 'bg-cc-tint text-cc-text-3'}"
          >
            {settings.duckEnabled ? "on" : "off"}
          </span>
        </div>

        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.duckEnabled}
            class="accent-cc-purple h-4 w-4 shrink-0"
            onchange={(e) => (settings.duckEnabled = (e.target as HTMLInputElement).checked)}
          />
          <span class="text-[12px] text-cc-text">
            Duck music under speech ({settings.duckDb} dB)
          </span>
        </div>

        {#if settings.duckEnabled}
          <div class="grid grid-cols-2 gap-4 p-2 bg-cc-tint rounded">
            <div class="flex flex-col gap-1">
              <span class="text-[10px] text-cc-text-3">Attack</span>
              <input
                type="range"
                min="50"
                max="1000"
                step="50"
                value={settings.duckAttackMs}
                class="w-full accent-cc-purple h-1.5 bg-cc-line rounded-lg cursor-pointer"
                oninput={(e) =>
                  (settings.duckAttackMs = Number((e.target as HTMLInputElement).value))}
              />
              <span class="text-[10px] mono text-cc-text-3">
                {settings.duckAttackMs} ms
              </span>
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-[10px] text-cc-text-3">Release</span>
              <input
                type="range"
                min="200"
                max="2000"
                step="100"
                value={settings.duckReleaseMs}
                class="w-full accent-cc-purple h-1.5 bg-cc-line rounded-lg cursor-pointer"
                oninput={(e) =>
                  (settings.duckReleaseMs = Number((e.target as HTMLInputElement).value))}
              />
              <span class="text-[10px] mono text-cc-text-3">
                {settings.duckReleaseMs} ms
              </span>
            </div>
          </div>
          <p class="text-[10px] text-cc-text-3">
            When speech is detected, music ducks by {Math.abs(settings.duckDb)} dB with smooth attack/release
            — Apna College / Coder Army tutorial style.
          </p>
        {/if}
      </section>
    {/if}

    <!-- Text overlay -->
    <section class="cc-panel flex min-h-0 flex-col gap-3 p-4">
      <h3 class="text-[14px] font-semibold text-cc-text">Title Overlay</h3>

      <div class="flex flex-col gap-2">
        <label for="polish-text" class="text-[12px] text-cc-text-2">Heading / Subtitle</label>
        <input
          id="polish-text"
          type="text"
          placeholder="e.g. React Basics · Part 2"
          value={settings.text}
          class="w-full px-3 py-2 rounded bg-cc-surface border border-cc-line text-[13px] text-cc-text focus:ring-2 focus:ring-cc-purple"
          oninput={(e) => (settings.text = (e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="flex items-center gap-2">
        <span class="text-[12px] text-cc-text-2 shrink-0">Position</span>
        <div class="flex gap-1">
          {#each POSITIONS as pos (pos.id)}
            <button
              type="button"
              class="px-2.5 py-1 text-[10px] rounded
                {settings.textPosition === pos.id
                ? 'bg-cc-purple text-white'
                : 'bg-cc-tint text-cc-text hover:bg-cc-line'}"
              onclick={() => setPosition(pos.id)}
            >
              {pos.label}
            </button>
          {/each}
        </div>
      </div>

      {#if settings.text.trim()}
        <div
          class="flex items-center justify-center p-3 bg-cc-surface rounded border border-cc-line"
        >
          <div
            class="relative inline-block"
            style={settings.textPosition === "bottom-left"
              ? "align-items:flex-end; justify-items:flex-start;"
              : settings.textPosition === "top-left"
                ? "align-items:flex-start; justify-items:flex-start;"
                : "align-items:center; justify-items:center;"}
          >
            <div
              class="bg-black/60 rounded px-2 py-1 text-[12px] font-medium text-white"
              style="white-space: nowrap;"
            >
              {settings.text}
            </div>
          </div>
        </div>
      {/if}
    </section>

    <!-- Render -->
    <section class="cc-panel flex min-h-0 flex-col gap-3 p-4">
      <div class="flex items-center justify-between">
        <h3 class="text-[14px] font-semibold text-cc-text">Render Polish</h3>
        <span
          class="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px]
            {renderResult
            ? 'bg-cc-keep text-cc-keep'
            : rendering
              ? 'bg-cc-warn text-cc-warn'
              : 'bg-cc-tint text-cc-text-3'}"
        >
          {renderResult ? "done" : rendering ? "rendering" : "idle"}
        </span>
      </div>

      <button
        type="button"
        class="cc-btn cc-btn-primary w-full text-[13px] font-semibold px-4 py-2.5"
        disabled={rendering || (!settings.text.trim() && !settings.musicPath)}
        onclick={renderPolish}
      >
        {rendering ? "Rendering…" : "Apply Polish to Video"}
      </button>

      {#if renderError}
        <div class="rounded bg-cc-cut/10 p-2 text-[11px] text-cc-cut border border-cc-cut/30">
          {renderError}
        </div>
      {/if}

      {#if renderResult}
        <div class="p-2 bg-cc-keep/10 rounded text-[11px] text-cc-keep border border-cc-keep/30">
          <div class="flex justify-between text-[10px]">
            <span>Output</span>
            <span class="truncate mono">{renderResult.output}</span>
          </div>
          <div class="flex justify-between text-[10px]">
            <span>Duration</span>
            <span
              >{Math.floor(renderResult.durationSecs / 60)}:{String(
                Math.floor(renderResult.durationSecs % 60),
              ).padStart(2, "0")}</span
            >
          </div>
          <div class="flex justify-between text-[10px]">
            <span>Size</span>
            <span>{formatBytes(renderResult.sizeBytes)}</span>
          </div>
        </div>
      {/if}
    </section>
  {/if}
</div>
