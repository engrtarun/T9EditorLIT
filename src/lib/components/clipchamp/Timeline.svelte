<script lang="ts">
  /**
   * Timeline — an interactive, zoomable track area over the source.
   *
   * This is a real editing surface, not decoration:
   *  - Click / drag the track to seek (scrub) the preview.
   *  - A playhead line follows playback and auto-stays in view when zoomed.
   *  - Ctrl + "-"/"="/"0" or Ctrl + mouse-wheel zoom the time axis in/out.
   *  - When a transcript is loaded, each line is tinted over the thumbnail
   *    strip — green for kept, red for cut — so you see decisions in context.
   *
   * Only the small derived payloads (peaks, thumbnail paths) live in the
   * store; the JPEGs stream straight from disk via the asset protocol and are
   * never read into the heap, keeping the zero-RAM rule intact.
   */
  import { project } from "../../stores/project.svelte";
  import { timeline } from "../../stores/timeline.svelte";
  import { player } from "../../stores/player.svelte";
  import { transcript } from "../../stores/transcript.svelte";
  import { cc } from "../../stores/cc.svelte";
  import { formatClock, thumbStep } from "../../timeline-utils";

  // Drag the timeline's top edge to change its height (a horizontal splitter).
  function startHeightResize(event: PointerEvent) {
    const startY = event.clientY;
    const startH = cc.timelineHeight;
    const move = (e: PointerEvent) => {
      // Dragging down (positive delta) grows the timeline.
      cc.timelineHeight = Math.min(460, Math.max(96, startH + (e.clientY - startY)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Extract (or reuse the cached) waveform + strip whenever the source changes.
  $effect(() => {
    if (project.info) {
      void timeline.load(project.info.path);
    } else {
      timeline.clear();
    }
  });

  const duration = $derived(project.info?.durationSecs ?? 0);

  // ── Zoom (time axis) ────────────────────────────────────────────────────
  // `zoom` is a width multiplier over the visible track: 1 = whole video fits,
  // higher = zoomed in and horizontally scrollable.
  let zoom = $state(1);
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 40;

  function zoomIn(): void {
    zoom = Math.min(MAX_ZOOM, Math.round(zoom * 1.5 * 100) / 100);
  }
  function zoomOut(): void {
    zoom = Math.max(MIN_ZOOM, Math.round((zoom / 1.5) * 100) / 100);
  }
  function resetZoom(): void {
    zoom = 1;
  }

  // ── Waveform + thumbnail DOM refs ───────────────────────────────────────
  let scrollBox = $state<HTMLDivElement | null>(null);
  let trackEl = $state<HTMLDivElement | null>(null);
  let waveBox = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);

  // Redraw the waveform whenever the peaks or the box size change.
  $effect(() => {
    const peaks = timeline.peaks;
    const box = waveBox;
    const el = canvas;
    if (!peaks || !box || !el) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (w === 0 || h === 0) return;
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      const ctx = el.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.fillStyle = "rgba(118, 17, 240, 0.72)";
      const mid = el.height / 2;
      const barW = el.width / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const amp = Math.min(1, Math.max(0, peaks[i]));
        const bh = Math.max(1, amp * (el.height - 2));
        ctx.fillRect(i * barW, mid - bh / 2, Math.max(1, barW - 0.5), bh);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(box);
    return () => ro.disconnect();
  });

  // Decimate the strip so a 2-hour video never puts 7200 <img> in the DOM.
  const step = $derived(timeline.thumbCount > 0 ? thumbStep(timeline.thumbCount) : 1);
  const frames = $derived.by(() => {
    const t = timeline.thumbs;
    const out: number[] = [];
    if (!t) return out;
    for (let i = 0; i < t.count; i += step) out.push(i);
    return out;
  });
  /** Seconds of source time each rendered frame stands in for. */
  const frameSpanSecs = $derived(step / timeline.thumbFps);
  const framePct = $derived(duration > 0 ? (frameSpanSecs / duration) * 100 : 0);

  // ── Live playhead ───────────────────────────────────────────────────────
  let currentSecs = $state(0);
  let playing = $state(false);
  const playheadPct = $derived(duration > 0 ? (currentSecs / duration) * 100 : 0);

  $effect(() => {
    const el = player.element;
    if (!el) return;
    currentSecs = el.currentTime;
    const onTime = () => {
      currentSecs = el.currentTime;
    };
    const onPlay = () => {
      playing = true;
    };
    const onPause = () => {
      playing = false;
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("seeked", onTime);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("seeked", onTime);
    };
  });

  // Keep the playhead centred while playing into a zoomed-in track.
  $effect(() => {
    const box = scrollBox;
    if (!box || duration <= 0 || zoom <= 1 || !playing) return;
    const frac = currentSecs / duration;
    const target = frac * box.scrollWidth - box.clientWidth / 2;
    box.scrollTo({ left: Math.max(0, target) });
  });

  // ── Click / drag to seek ────────────────────────────────────────────────
  let dragging = $state(false);

  function secsFromClientX(clientX: number): number {
    const el = trackEl;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const frac = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(duration, frac * duration));
  }

  function onPointerDown(e: PointerEvent): void {
    if (!project.hasMedia) return;
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    player.seek(secsFromClientX(e.clientX));
  }
  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    player.seek(secsFromClientX(e.clientX));
  }
  function onPointerUp(): void {
    dragging = false;
  }

  // ── Keyboard zoom: Ctrl + "-"/"="/"0" ───────────────────────────────────
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        resetZoom();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── Ctrl + mouse-wheel zoom (non-passive so preventDefault works) ───────
  $effect(() => {
    const el = scrollBox;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
</script>

<section
  class="relative flex shrink-0 flex-col border-t border-cc-line bg-cc-surface"
  style="height: {cc.timelineHeight}px"
  aria-label="Timeline"
>
  <!-- Drag handle on the timeline's top edge. -->
  <div
    class="absolute inset-x-0 -top-[3px] z-20 h-[6px] cursor-row-resize hover:bg-cc-purple/50"
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize timeline"
    onpointerdown={startHeightResize}
  ></div>
  <!-- Transport -->
  <div class="relative flex h-11 shrink-0 items-center justify-center gap-1 border-b border-cc-line-soft">
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-cc-text-3
      hover:bg-cc-tint"
      title="Seek to start"
      disabled={!project.hasMedia}
      onclick={() => player.seek(0)}
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
      onclick={() => player.scrub(-5)}
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
      onclick={() => player.togglePlay()}
    >
      {#if playing}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
        </svg>
      {:else}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M7 4.5v15l13-7.5z" />
        </svg>
      {/if}
    </button>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-cc-text-3
      hover:bg-cc-tint"
      title="Forward 5 seconds shift+→"
      disabled={!project.hasMedia}
      onclick={() => player.scrub(5)}
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
      {project.hasMedia ? `${formatClock(currentSecs)} / ${project.durationLabel}` : "0:00 / 0:00"}
    </span>

    <!-- Zoom controls -->
    <div class="absolute right-3 flex items-center gap-1">
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded text-cc-text-3 hover:bg-cc-tint"
        title="Zoom out (Ctrl + -)"
        disabled={!project.hasMedia || zoom <= MIN_ZOOM}
        onclick={zoomOut}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
      </button>
      <button
        type="button"
        class="mono h-6 min-w-[38px] rounded px-1 text-[10px] text-cc-text-3 hover:bg-cc-tint"
        title="Reset zoom (Ctrl + 0)"
        disabled={!project.hasMedia}
        onclick={resetZoom}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded text-cc-text-3 hover:bg-cc-tint"
        title="Zoom in (Ctrl + +)"
        disabled={!project.hasMedia || zoom >= MAX_ZOOM}
        onclick={zoomIn}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </div>
  </div>

  <!-- Track area -->
  <div class="relative min-h-0 flex-1 overflow-hidden p-3">
    {#if !project.hasMedia}
      <div
        class="flex h-full items-center justify-center rounded-md border-2 border-dashed
        border-cc-line"
      >
        <span class="text-[12.5px] text-cc-text-3">Drag &amp; drop media here</span>
      </div>
    {:else}
      <div bind:this={scrollBox} class="h-full w-full overflow-x-auto overflow-y-hidden">
        <div
          bind:this={trackEl}
          class="relative flex h-full cursor-pointer flex-col gap-2 select-none"
          style={`width: ${zoom * 100}%; min-width: 100%;`}
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          role="presentation"
        >
          <!-- Thumbnail strip: 1 fps cache, decimated for the DOM. -->
          <div
            class="h-16 shrink-0 overflow-hidden rounded-md border border-cc-line-soft
            bg-cc-surface"
          >
            {#if timeline.hasThumbs}
              <div class="flex h-full w-full">
                {#each frames as i (i)}
                  <img
                    src={timeline.thumbUrl(i) ?? undefined}
                    alt=""
                    loading="lazy"
                    draggable="false"
                    class="h-full shrink-0 object-cover"
                    style={`width: ${framePct}%`}
                  />
                {/each}
              </div>
            {:else if timeline.loading}
              <div class="flex h-full items-center justify-center">
                <span class="mono text-[10.5px] text-cc-text-4">building thumbnail strip…</span>
              </div>
            {:else}
              <div class="flex h-full items-center justify-center">
                <span class="mono text-[10.5px] text-cc-text-4">no thumbnails</span>
              </div>
            {/if}
          </div>

          <!-- Waveform: one peak per bucket, drawn on a small canvas. -->
          <div
            bind:this={waveBox}
            class="h-10 shrink-0 overflow-hidden rounded-md border border-cc-line-soft
            bg-cc-sunken"
          >
            {#if timeline.hasWaveform}
              <canvas bind:this={canvas} class="block h-full w-full"></canvas>
            {:else if timeline.loading}
              <div class="flex h-full items-center justify-center">
                <span class="mono text-[10.5px] text-cc-text-4">extracting waveform…</span>
              </div>
            {:else if timeline.error}
              <div class="flex h-full items-center justify-center px-3">
                <span class="mono truncate text-[10.5px] text-cc-cut">{timeline.error}</span>
              </div>
            {:else}
              <div class="flex h-full items-center justify-center">
                <span class="mono text-[10.5px] text-cc-text-4">no waveform</span>
              </div>
            {/if}
          </div>

          <!-- Cut / keep overlay over the thumbnail strip, from the transcript. -->
          {#if transcript.hasTranscript && duration > 0}
            <div class="pointer-events-none absolute inset-x-0 top-0 h-16">
              {#each transcript.lines as line (line.id)}
                {@const left = (line.startSecs / duration) * 100}
                {@const width = Math.max(0.15, ((line.endSecs - line.startSecs) / duration) * 100)}
                <div
                  class="absolute top-0 bottom-0 border-x"
                  style={`left:{left}%; width:{width}%; background:${
                    line.keep ? "rgba(52,199,89,0.16)" : "rgba(255,69,58,0.30)"
                  }; border-color:${line.keep ? "rgba(52,199,89,0.35)" : "rgba(255,69,58,0.5)"}`}
                ></div>
              {/each}
            </div>
          {/if}

          <!-- Playhead -->
          {#if duration > 0}
            <div
              class="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-cc-purple"
              style={`left:${playheadPct}%`}
            >
              <div
                class="absolute -top-0.5 -left-[5px] h-2.5 w-2.5 rotate-45 rounded-[2px] bg-cc-purple"
              ></div>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</section>
