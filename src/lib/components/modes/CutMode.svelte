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
  import { shortcuts } from "../../stores/shortcuts.svelte";

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

  /**
   * X cuts / V keeps the transcript line under the playhead — the same
   * actions the per-row keep/cut buttons perform, just keyboard-driven.
   * `Delete` / `Backspace` cut it too: with no multi-clip selection model,
   * the line under the playhead *is* the selection.
   *
   * These used to be a private `window` listener here, which broke the shell's
   * "one `keydown` dispatcher" rule and died with the `{#key}` that unmounts
   * this panel. The registry keeps them alive for exactly as long as Cut mode
   * is resident, which is the correct lifetime — and `BINDINGS` then lists
   * them in the cheat sheet for free.
   */
  function lineUnderPlayhead(): number {
    const t = player.currentTime;
    return transcript.lines.findIndex((l) => t >= l.startSecs && t < l.endSecs);
  }

  $effect(() => {
    const cut = () => {
      const i = lineUnderPlayhead();
      if (i >= 0) void transcript.cut(i);
    };
    const keep = () => {
      const i = lineUnderPlayhead();
      if (i >= 0) void transcript.keep(i);
    };
    const un = [
      shortcuts.bind("cutLine", cut),
      shortcuts.bind("delete", cut),
      shortcuts.bind("keepLine", keep),
    ];
    return () => un.forEach((fn) => fn());
  });

  function formatTime(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  /**
   * The three states a line can be worked in.
   *
   * Green = settled keep. Red = cut. Amber = the analyser proposed a cut and
   * the line is still marked keep, i.e. nobody has ruled on it yet — the one
   * state that actually needs a human decision, so it gets the colour that
   * sits between the two settled ones.
   */
  type RowState = "keep" | "cut" | "review";

  function rowState(line: { keep: boolean; flag: string }): RowState {
    if (!line.keep) return "cut";
    if (line.flag !== "none") return "review";
    return "keep";
  }

  const ROW_STYLE: Record<RowState, { border: string; tint: string; badge: string }> = {
    keep: { border: "var(--color-cc-keep)", tint: "transparent", badge: "var(--color-cc-keep)" },
    cut: { border: "var(--color-cc-cut)", tint: "transparent", badge: "var(--color-cc-cut)" },
    review: {
      border: "var(--color-cc-review)",
      tint: "color-mix(in oklab, var(--color-cc-review) 7%, transparent)",
      badge: "var(--color-cc-review)",
    },
  };

  /** Human label for a flag, so the badge reads "retake" not "wrong_example". */
  const FLAG_LABEL: Record<string, string> = {
    silence: "silence",
    fumble: "fumble",
    retake: "retake",
    wrong_example: "wrong example",
  };

  function flagLabel(flag: string): string {
    return FLAG_LABEL[flag] ?? flag;
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
          {#if transcript.transcribing}
            <span
              class="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-cc-purple/30 border-t-cc-purple"
              aria-hidden="true"
            ></span>
            {#if transcript.progressTotal > 0}
              {transcript.progressCompleted}/{transcript.progressTotal}
            {:else}
              {transcript.progress ?? "working…"}
            {/if}
          {:else}
            Transcribe
          {/if}
        </button>
      {/if}
      {#if project.info}
        <button
          type="button"
          class="cc-btn text-[11px]"
          disabled={transcript.transcribing ||
            transcript.removingSilence ||
            !transcript.hasTranscript}
          onclick={() => project.info && transcript.removeSilence(project.info.path)}
          title="Detect dead air and cut it out (keeps speech)"
        >
          {#if transcript.removingSilence}
            <span
              class="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-cc-purple/30 border-t-cc-purple"
              aria-hidden="true"
            ></span>
            detecting…
          {:else}
            Remove silence
          {/if}
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

  <!-- Silence-removal result banner. -->
  {#if transcript.silenceInfo}
    <div
      class="rounded border border-cc-purple/25 bg-cc-tint/40 px-2.5 py-1.5 text-[11px] text-cc-text-2"
      role="status"
      aria-live="polite"
    >
      {transcript.silenceInfo}
    </div>
  {/if}

  <!-- Legend. Three colours with no key is worse than no colour at all, and
       this strip costs one row. -->
  {#if transcript.hasTranscript}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-cc-text-3">
      <span class="flex items-center gap-1.5">
        <span class="h-2.5 w-0.5 rounded-full bg-cc-keep"></span>
        keep
      </span>
      <span class="flex items-center gap-1.5">
        <span class="h-2.5 w-0.5 rounded-full bg-cc-review"></span>
        needs review
        <span class="text-cc-text-4">({transcript.reviewCount})</span>
      </span>
      <span class="flex items-center gap-1.5">
        <span class="h-2.5 w-0.5 rounded-full bg-cc-cut"></span>
        cut
      </span>
      {#if transcript.fixedCount > 0}
        <span class="ml-auto flex items-center gap-1.5 text-cc-text-4">
          <span class="h-1.5 w-1.5 rounded-full bg-cc-purple-3"></span>
          {transcript.fixedCount} spelling
          {transcript.fixedCount === 1 ? "fix" : "fixes"} · hover to compare
        </span>
      {/if}
    </div>
  {/if}

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
    {:else if transcript.transcribing}
      <div class="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
        <span
          class="inline-block h-7 w-7 animate-spin rounded-full border-2 border-cc-purple/25 border-t-cc-purple"
          aria-hidden="true"
        ></span>
        <span class="text-[13px] font-semibold text-cc-text">
          {transcript.progress === "extracting audio"
            ? "Extracting audio…"
            : transcript.progress === "transcribing"
              ? "Transcribing with Whisper…"
              : transcript.progress === "correcting"
                ? "Fixing spelling with Groq…"
                : transcript.progress === "analysing"
                  ? "Analysing tone with Gemini…"
                  : transcript.progress === "saving"
                    ? "Saving…"
                    : "Working…"}
        </span>
        {#if transcript.progressTotal > 0}
          <div class="w-full max-w-[220px]">
            <div class="h-2 w-full overflow-hidden rounded-full bg-cc-line">
              <div
                class="h-full rounded-full bg-cc-purple transition-all duration-500"
                style="width: {Math.min(
                  100,
                  (transcript.progressCompleted / transcript.progressTotal) * 100,
                )}%"
              ></div>
            </div>
            <div class="mono mt-1.5 flex justify-between text-[10.5px] text-cc-text-3">
              <span>{transcript.progressCompleted} / {transcript.progressTotal}</span>
              <span
                >{Math.round(
                  (transcript.progressCompleted / transcript.progressTotal) * 100,
                )}%</span
              >
            </div>
          </div>
        {:else}
          <span class="mono text-[11px] text-cc-text-3">
            {transcript.progress ?? "starting…"}
          </span>
        {/if}
        <span class="max-w-[240px] text-[11px] leading-relaxed text-cc-text-4">
          Long videos take a few minutes — audio is chunked, sent to Groq Whisper, then the spelling
          is cleaned up line by line.
        </span>
      </div>
    {:else if transcript.error}
      <div class="flex flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center">
        <span class="text-[12.5px] text-cc-cut">{transcript.error}</span>
      </div>
    {:else if !transcript.hasTranscript}
      <div class="flex flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center">
        <span class="text-[12.5px] text-cc-text-3">no transcript yet</span>
        <span class="mono text-[10px] text-cc-text-4">
          run transcription to populate (Groq Whisper → Groq autocorrect → Gemini flags)
        </span>
      </div>
    {:else}
      <div bind:this={viewport} class="flex-1 overflow-y-auto p-2">
        <div style="height: {visible.top}px"></div>
        {#each transcript.lines.slice(visible.start, visible.end) as line, idx (line.id)}
          {@const i = visible.start + idx}
          {@const state = rowState(line)}
          <div
            class="group relative flex cursor-pointer items-start gap-2 rounded py-1.5 pl-3 pr-2 hover:bg-cc-tint"
            class:opacity-45={!line.keep}
            style="min-height: {ROW_HEIGHT}px; border-left: 3px solid {ROW_STYLE[state]
              .border}; background: {ROW_STYLE[state].tint}"
            onclick={() => player.seek(line.startSecs)}
            onkeydown={(e) => e.key === "Enter" && player.seek(line.startSecs)}
            role="button"
            tabindex="0"
          >
            <span class="mono shrink-0 pt-0.5 text-[10px] text-cc-text-4">
              {formatTime(line.startSecs)}
            </span>
            <span class="flex-1 text-[12.5px] leading-snug text-cc-text">
              {#if line.flag !== "none"}
                <span
                  class="mr-1.5 inline-block translate-y-[-1px] rounded px-1.5 py-0.5 text-[9.5px] font-semibold align-middle"
                  style="background: color-mix(in oklab, {ROW_STYLE[state]
                    .badge} 15%, transparent); color: {ROW_STYLE[state].badge}"
                  title={line.flag}
                >
                  {flagLabel(line.flag)}
                </span>
              {/if}
              {#if line.originalText}
                <!-- A dot, not a word: 300 lines of "fixed" would drown the
                     text, but a dot is cheap and the tooltip carries the
                     detail. -->
                <span
                  class="mr-1 inline-block h-1.5 w-1.5 translate-y-[-1px] rounded-full bg-cc-purple-3 align-middle"
                  aria-label="spelling fixed by autocorrect"
                ></span>
              {/if}
              <!-- Clamp only the text, not the badges: a flag the analyser
                   raised must stay visible even when the sentence runs on. -->
              <span class="line-clamp-2">{line.text}</span>
            </span>
            <button
              type="button"
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
              style={line.keep
                ? "background: var(--color-cc-keep-dim); color: var(--color-cc-keep)"
                : "background: var(--color-cc-cut-dim); color: var(--color-cc-cut)"}
              onclick={(e) => {
                e.stopPropagation();
                transcript.toggleKeep(i);
              }}
              title={line.keep ? "Cut (X)" : "Keep (V)"}
            >
              {line.keep ? "keep" : "cut"}
            </button>

            <!-- Absolutely positioned so the virtual scroll's fixed row height
                 still holds: a tooltip that took up space would desync
                 ROW_HEIGHT and every row below it would jump. -->
            {#if line.originalText}
              <span
                class="pointer-events-none absolute left-3 top-full z-20 hidden w-[min(420px,90%)] rounded-md border border-cc-line bg-cc-surface px-2.5 py-2 text-[11.5px] leading-snug text-cc-text-2 shadow-lg group-hover:block"
                role="tooltip"
              >
                <span class="mono text-[9.5px] tracking-wide text-cc-text-4 uppercase">
                  Whisper heard
                </span>
                <span class="mt-0.5 block text-cc-text-4 line-through">
                  {line.originalText}
                </span>
                <span class="mono mt-1.5 block text-[9.5px] tracking-wide text-cc-text-4 uppercase">
                  Autocorrect
                </span>
                <span class="mt-0.5 block text-cc-text">{line.text}</span>
              </span>
            {/if}
          </div>
        {/each}
        <div style="height: {visible.bottom}px"></div>
      </div>
    {/if}
  </div>
</div>
