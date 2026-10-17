<script lang="ts">
  /**
   * Mode 1 — Transcript & Cut.
   *
   * Virtual scroll: only the lines inside (plus a small overscan around) the
   * viewport are in the DOM, so a 2-hour transcript does not bloat the heap.
   * Keep/cut toggles are undoable via Ctrl+Z / Ctrl+Shift+Z.
   */
  import { project } from "../../stores/project.svelte";
  import { transcript } from "../../stores/transcript.svelte";
  import { player } from "../../stores/player.svelte";

  const ROW_HEIGHT = 64;
  const OVERSCAN = 10;

  let viewport = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let viewportHeight = $state(400);

  $effect(() => {
    if (!viewport) return;
    const update = () => {
      scrollTop = viewport!.scrollTop;
      viewportHeight = viewport!.clientHeight;
    };
    update();
    viewport.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(viewport);
    return () => {
      viewport?.removeEventListener("scroll", update);
      ro.disconnect();
    };
  });

  const visible = $derived.by(() => {
    const total = transcript.lines.length;
    if (total === 0) return { start: 0, end: 0, top: 0, bottom: 0 };
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const count = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(total, start + count);
    return {
      start,
      end,
      top: start * ROW_HEIGHT,
      bottom: (total - end) * ROW_HEIGHT,
    };
  });

  $effect(() => {
    if (project.info) {
      void transcript.load(project.info.path);
    } else {
      transcript.clear();
    }
  });

  // X cuts / V keeps the transcript line under the playhead — the same
  // actions the per-row keep/cut buttons perform, just keyboard-driven.
  $effect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const t = player.currentTime;
      const i = transcript.lines.findIndex((l) => t >= l.startSecs && t < l.endSecs);
      if (i < 0) return;
      if (e.key === "x" || e.key === "X") {
        e.preventDefault();
        void transcript.cut(i);
      } else if (e.key === "v" || e.key === "V") {
        e.preventDefault();
        void transcript.keep(i);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function formatTime(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 p-3">
  <div class="flex items-center justify-between">
    <span class="cc-label">Transcript</span>
    <div class="flex items-center gap-2">
      {#if project.info}
        <button
          type="button"
          class="cc-btn text-[11px]"
          disabled={transcript.transcribing}
          onclick={() => project.info && transcript.transcribe(project.info.path)}
        >
          {transcript.transcribing ? (transcript.progress ?? "working...") : "Transcribe"}
        </button>
      {/if}
      <button
        type="button"
        class="cc-btn text-[11px]"
        disabled={!transcript.canUndo}
        onclick={() => transcript.undo()}
        title="Undo (Ctrl+Z)"
      >
        Undo
      </button>
      <button
        type="button"
        class="cc-btn text-[11px]"
        disabled={!transcript.canRedo}
        onclick={() => transcript.redo()}
        title="Redo (Ctrl+Shift+Z)"
      >
        Redo
      </button>
      <span class="mono text-[10px] text-cc-text-3">
        {transcript.hasTranscript
          ? `${transcript.keptCount} kept · ${transcript.cutCount} cut`
          : ""}
      </span>
    </div>
  </div>

  <div class="cc-panel flex min-h-0 flex-1 flex-col overflow-hidden">
    {#if !project.hasMedia}
      <div class="flex flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center">
        <span class="text-[12.5px] font-semibold text-cc-text">Import a video first</span>
        <span class="text-[11.5px] leading-relaxed text-cc-text-3">
          The transcript is transcribed from the source — nothing to show until one is loaded.
        </span>
      </div>
    {:else if transcript.loading}
      <div class="flex flex-1 items-center justify-center p-4">
        <span class="mono text-[11px] text-cc-text-3">loading transcript…</span>
      </div>
    {:else if transcript.error}
      <div class="flex flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center">
        <span class="text-[12.5px] text-cc-cut">{transcript.error}</span>
      </div>
    {:else if !transcript.hasTranscript}
      <div class="flex flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center">
        <span class="text-[12.5px] text-cc-text-3">no transcript yet</span>
        <span class="mono text-[10px] text-cc-text-4">
          run transcription to populate (Groq Whisper → Gemini flags)
        </span>
      </div>
    {:else}
      <div bind:this={viewport} class="flex-1 overflow-y-auto p-2">
        <div style="height: {visible.top}px"></div>
        {#each transcript.lines.slice(visible.start, visible.end) as line, idx (line.id)}
          {@const i = visible.start + idx}
          <div
            class="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-cc-tint cursor-pointer"
            class:opacity-40={!line.keep}
            style="min-height: {ROW_HEIGHT}px"
            onclick={() => player.seek(line.startSecs)}
            onkeydown={(e) => e.key === "Enter" && player.seek(line.startSecs)}
            role="button"
            tabindex="0"
          >
            <span class="mono shrink-0 text-[10px] text-cc-text-4 pt-0.5">
              {formatTime(line.startSecs)}
            </span>
            <span class="flex-1 text-[12.5px] leading-snug text-cc-text line-clamp-2">
              {line.text}
            </span>
            {#if line.flag !== "none"}
              <span
                class="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold"
                style="background: var(--color-cut-dim); color: var(--color-cut)"
                title={line.flag}
              >
                {line.flag}
              </span>
            {/if}
            <button
              type="button"
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
              style={line.keep
                ? "background: color-mix(in oklab, var(--color-keep) 18%, transparent); color: var(--color-keep)"
                : "background: var(--color-cut-dim); color: var(--color-cut)"}
              onclick={(e) => {
                e.stopPropagation();
                transcript.toggleKeep(i);
              }}
              title={line.keep ? "Cut (X)" : "Keep (V)"}
            >
              {line.keep ? "keep" : "cut"}
            </button>
          </div>
        {/each}
        <div style="height: {visible.bottom}px"></div>
      </div>
    {/if}
  </div>
</div>
