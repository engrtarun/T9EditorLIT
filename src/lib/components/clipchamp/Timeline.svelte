<script lang="ts">
  /**
   * Timeline — transport toolbar over the track area.
   *
   * The transport is dead until a source exists, exactly like the reference
   * (its buttons render disabled on an empty project too). The track area
   * carries the waveform canvas and the ~1 fps thumbnail strip, both rendered
   * from FFmpeg-extracted data cached on disk (Chunk 3). Nothing here buffers
   * decoded frames in the heap.
   */
  import { project } from "../../stores/project.svelte";
  import { timeline } from "../../stores/timeline.svelte";
  import { player } from "../../stores/player.svelte";
  import { formatClock, thumbStep } from "../../timeline-utils";

  // Extract (or reuse the cached) waveform + strip whenever the source changes.
  $effect(() => {
    if (project.info) {
      void timeline.load(project.info.path);
    } else {
      timeline.clear();
    }
  });

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
  const framePct = $derived(
    (project.info?.durationSecs ?? 0) > 0
      ? (frameSpanSecs / (project.info?.durationSecs as number)) * 100
      : 0,
  );

  // Live playhead readout — event-driven (timeupdate/play/pause), no polling.
  let currentSecs = $state(0);
  let playing = $state(false);

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
</script>

<section
  class="flex h-[168px] shrink-0 flex-col border-t border-cc-line bg-cc-surface"
  aria-label="Timeline"
>
  <!-- Transport -->
  <div class="flex h-11 shrink-0 items-center justify-center gap-1 border-b border-cc-line-soft">
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
  </div>

  <!-- Track area -->
  <div class="relative min-h-0 flex-1 overflow-hidden p-3">
    <div class="flex h-full flex-col gap-2">
      {#if !project.hasMedia}
        <div
          class="flex flex-1 items-center justify-center rounded-md border-2 border-dashed
          border-cc-line"
        >
          <span class="text-[12.5px] text-cc-text-3">Drag &amp; drop media here</span>
        </div>
      {:else}
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
      {/if}
    </div>
  </div>
</section>
