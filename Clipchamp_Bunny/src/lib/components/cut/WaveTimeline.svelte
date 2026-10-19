<script lang="ts">
  import { project } from '../../stores/project.svelte';
  import { player } from '../../stores/player.svelte';
  import { layout } from '../../stores/layout.svelte';
  import { thumbUrl } from '../../media';
  import { clamp, fmtShort, fmtTime, niceStep } from '../../utils';

  /* Clipchamp timeline metrics (measured on the OBS capture + DOM extract):
     tool row 30px · ruler 26px · T lane 30px · video lane 52px · audio lane 44px */
  const RULER_H = 26;
  const TEXT_H = 30;
  const VIDEO_H = 52;
  const AUDIO_H = 44;

  let wrap: HTMLDivElement | null = $state(null);
  let filmCanvas: HTMLCanvasElement | null = $state(null);
  let backCanvas: HTMLCanvasElement | null = $state(null);
  let waveCanvas: HTMLCanvasElement | null = $state(null);
  let viewW = $state(1200);
  let scrollLeft = $state(0);

  const zoom = $derived(player.zoom);
  const contentW = $derived(Math.max(600, (project.durationSec + 4) * zoom));
  const step = $derived(niceStep(zoom));
  const minor = $derived(step / (step >= 5 ? 5 : step >= 2 ? 4 : 2));

  const ticks = $derived.by(() => {
    const out: Array<{ t: number; major: boolean }> = [];
    for (let t = 0; t <= project.durationSec + 0.001 && out.length < 3000; t += minor) {
      out.push({ t, major: Math.abs(t / step - Math.round(t / step)) < 1e-6 });
    }
    return out;
  });

  /* ---------------------------------------------------------------- thumbnails
     Only the frames inside the viewport are fetched, so a 2-hour timeline
     never pulls thousands of JPEGs into RAM. */
  const thumbImgs = new Map<number, HTMLImageElement>();

  function ensureThumbs(fromSec: number, toSec: number) {
    const strip = project.thumbnails;
    if (!strip) return;
    const i0 = Math.max(0, Math.floor(fromSec * strip.fps));
    const i1 = Math.min(strip.count - 1, Math.ceil(toSec * strip.fps));
    for (let i = i0; i <= i1; i++) {
      if (thumbImgs.has(i)) continue;
      const img = new Image();
      img.decoding = 'async';
      img.src = thumbUrl(strip, i);
      img.onload = () => drawVideoLane();
      thumbImgs.set(i, img);
    }
    if (thumbImgs.size > 260) {
      for (const k of [...thumbImgs.keys()]) {
        if (k < i0 - 80 || k > i1 + 80) thumbImgs.delete(k);
      }
    }
  }

  /* ---------------------------------------------------------------- colours
     gold = keep · red = fumble / repeat / galat example · grey = khamoshi */
  const BUCKET = 0.25;
  const colours = $derived.by(() => {
    const n = Math.ceil((project.durationSec + 4) / BUCKET);
    const out = new Array<string>(n).fill('#3a3d4c');
    for (const l of project.lines) {
      const c = l.flag === 'silence' ? '#4a4d5c' : l.keep === 'cut' ? '#e5484d' : '#d4af37';
      const from = Math.max(0, Math.floor(l.startSec / BUCKET));
      const to = Math.min(n - 1, Math.ceil(l.endSec / BUCKET));
      for (let i = from; i <= to; i++) out[i] = c;
    }
    return out;
  });

  /* ---------------------------------------------------------------- drawing */
  function drawVideoLane() {
    const c = filmCanvas;
    const b = backCanvas;
    if (!c || !b) return;
    const w = contentW;
    c.width = w;
    c.height = VIDEO_H;
    b.width = w;
    b.height = VIDEO_H;
    const ctx = c.getContext('2d');
    const bctx = b.getContext('2d');
    if (!ctx || !bctx) return;

    // ---- back layer: dark bed + red hatched cut gaps
    bctx.clearRect(0, 0, w, VIDEO_H);
    bctx.fillStyle = '#12131a';
    bctx.fillRect(0, 0, w, VIDEO_H);
    bctx.fillStyle = 'rgba(229,72,77,0.10)';
    for (const [a, z] of project.cutRanges) {
      bctx.fillRect(a * zoom, 0, (z - a) * zoom, VIDEO_H);
    }
    bctx.strokeStyle = 'rgba(229,72,77,0.30)';
    bctx.lineWidth = 1;
    for (const [a, z] of project.cutRanges) {
      const x0 = a * zoom;
      const x1 = z * zoom;
      for (let hx = x0 - VIDEO_H; hx < x1; hx += 9) {
        bctx.beginPath();
        bctx.moveTo(hx, VIDEO_H);
        bctx.lineTo(hx + VIDEO_H, 0);
        bctx.stroke();
      }
    }

    // ---- front layer: real filmstrip inside the kept ranges
    ctx.clearRect(0, 0, w, VIDEO_H);
    const strip = project.thumbnails;
    for (const [a, z] of project.keptRanges) {
      const x0 = a * zoom;
      const x1 = z * zoom;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, VIDEO_H);
      ctx.clip();
      if (strip) {
        const i0 = Math.max(0, Math.floor(a * strip.fps));
        const i1 = Math.min(strip.count - 1, Math.floor(z * strip.fps));
        for (let i = i0; i <= i1; i++) {
          const img = thumbImgs.get(i);
          if (!img || !img.complete || !img.naturalWidth) continue;
          ctx.drawImage(img, (i / strip.fps) * zoom, 0, Math.max(1, zoom), VIDEO_H);
        }
      }
      ctx.restore();
      ctx.strokeStyle = 'rgba(124,92,255,0.95)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, 0.5, Math.max(1, x1 - x0 - 1), VIDEO_H - 1);
    }
  }

  function drawWave() {
    const c = waveCanvas;
    const peaks = project.waveform?.peaks;
    if (!c || !peaks?.length) return;
    const w = contentW;
    c.width = w;
    c.height = AUDIO_H;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#14151d';
    ctx.fillRect(0, 0, w, AUDIO_H);

    const mid = AUDIO_H / 2;
    const dur = project.durationSec || 1;
    for (let px = 0; px < w; px += 2) {
      const sec = px / zoom;
      const pi = Math.min(peaks.length - 1, Math.floor((sec / dur) * peaks.length));
      const p = peaks[Math.max(0, pi)] ?? 0;
      const hgt = Math.max(1, p * (AUDIO_H - 10));
      const ci = Math.min(colours.length - 1, Math.floor(sec / BUCKET));
      ctx.fillStyle = colours[ci] ?? '#3a3d4c';
      ctx.fillRect(px, mid - hgt / 2, 2, hgt);
    }
    ctx.fillStyle = '#2a2c38';
    ctx.fillRect(0, mid, w, 1);
  }

  $effect(() => {
    void project.waveform;
    void zoom;
    void contentW;
    void colours;
    void project.keptRanges;
    void project.cutRanges;
    drawWave();
    drawVideoLane();
  });

  /* ---------------------------------------------------------------- viewport */
  $effect(() => {
    const w = wrap;
    if (!w) return;
    const z = zoom;
    const sl = scrollLeft;
    viewW = w.clientWidth;
    const fromSec = sl / z;
    const toSec = (sl + viewW) / z;
    ensureThumbs(fromSec, toSec);
    drawVideoLane();
    const obs = new ResizeObserver(() => (viewW = w.clientWidth));
    obs.observe(w);
    return () => obs.disconnect();
  });

  /* ---------------------------------------------------------------- actions */
  function seekFromEvent(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const t = clamp((e.clientX - rect.left) / zoom, 0, project.durationSec);
    player.seek(project.snapTime(t));
  }

  function laneKeys(e: KeyboardEvent) {
    const small = e.shiftKey ? 1 : 1 / 30;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      player.nudge(-small);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      player.nudge(small);
    }
  }

  const aria = $derived({
    role: 'slider',
    tabindex: 0,
    'aria-label': 'Timeline',
    'aria-valuemin': 0,
    'aria-valuemax': Math.round(project.durationSec),
    'aria-valuenow': Math.round(player.currentTime)
  });

  function nudgeZoom(dir: 1 | -1) {
    player.zoom = clamp(zoom * (dir === 1 ? 1.4 : 1 / 1.4), 4, 220);
  }

  function zoomFit() {
    const w = wrap?.clientWidth ?? 1200;
    player.zoom = clamp(w / Math.max(project.durationSec, 1), 4, 220);
  }

  function doSplit() {
    if (project.splitAt(player.currentTime)) player.seek(project.snapTime(player.currentTime));
  }

  // follow the playhead while playing
  $effect(() => {
    const w = wrap;
    const t = player.currentTime;
    const z = zoom;
    if (!w || !player.playing) return;
    const x = t * z;
    if (x < w.scrollLeft + 40 || x > w.scrollLeft + w.clientWidth - 80) {
      w.scrollLeft = Math.max(0, x - w.clientWidth / 2);
    }
  });
</script>

<!-- BOTTOM BLOCK — Clipchamp's timeline: tool row, ruler, lanes.
     Height hugs the content so no dead space is left under the audio lane. -->
<section
  data-focus="timeline"
  tabindex="-1"
  class="relative flex shrink-0 flex-col border-t border-nc-line bg-nc-panel outline-none
         {layout.timelineCollapsed ? 'h-[31px]' : 'h-auto'}"
>
  <!-- TOOL ROW: tools left, transport centred, legend right.
       Zoom + collapse live in the floating bottom-right toolbar, as in Clipchamp. -->
  <div class="relative flex h-[30px] shrink-0 items-center gap-1 border-b border-nc-line px-2">
    <div class="flex items-center gap-0.5">
      <button
        class="grid h-7 w-7 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
        title="Auto-detect fumbles (AI)"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
          <path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z" />
        </svg>
      </button>
      <button
        onclick={doSplit}
        class="grid h-7 w-7 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
        title="Split at playhead (S / Ctrl+B)"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
        >
          <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
          <path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" />
        </svg>
      </button>
      <button
        onclick={() => {
          project.snap = !project.snap;
          player.snap = project.snap;
        }}
        class="grid h-7 w-7 place-items-center rounded-md transition-colors
               {project.snap
          ? 'text-nc-gold hover:bg-nc-panel-2'
          : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
        title="Snap to line boundaries"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
        >
          <path d="M6 3v7a6 6 0 0 0 12 0V3M6 3H3M18 3h3M9 21h6" />
        </svg>
      </button>
    </div>

    <!-- centred transport -->
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div class="pointer-events-auto flex items-center gap-1.5">
        <button
          onclick={() => player.seek(0)}
          class="grid h-7 w-7 place-items-center rounded-full text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
          title="Go to start"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 5h2v14H6zM20 5L9 12l11 7z" />
          </svg>
        </button>
        <button
          onclick={() => player.seek(clamp(player.currentTime - 5, 0, project.durationSec))}
          class="grid h-7 w-7 place-items-center rounded-full text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
          title="Back 5s (J)"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <path d="M11 17l-5-5 5-5" /><path d="M18 17l-5-5 5-5" />
            <text x="12" y="21" font-size="7" fill="currentColor" text-anchor="middle">5</text>
          </svg>
        </button>
        <button
          onclick={() => player.seek(clamp(player.currentTime + 5, 0, project.durationSec))}
          class="grid h-7 w-7 place-items-center rounded-full text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
          title="Forward 5s (L)"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <path d="M13 17l5-5-5-5" /><path d="M6 17l5-5-5-5" />
            <text x="12" y="21" font-size="7" fill="currentColor" text-anchor="middle">5</text>
          </svg>
        </button>
        <button
          onclick={() => player.toggle()}
          class="grid h-8 w-8 place-items-center rounded-full border border-nc-line-2 bg-nc-panel-2 text-nc-txt hover:bg-nc-line"
          title="Play / Pause (Space)"
        >
          {#if player.playing}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
            </svg>
          {:else}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          {/if}
        </button>
        <span class="ml-1 font-mono text-[12px] text-nc-txt">
          {fmtTime(player.currentTime)}
          <span class="text-nc-mut-2"> / {fmtTime(project.durationSec)}</span>
        </span>
      </div>
    </div>

    <!-- right: legend -->
    <div class="ml-auto flex items-center gap-1.5">
      <span class="flex items-center gap-1 text-[9px] text-nc-mut">
        <i class="inline-block h-1.5 w-1.5 rounded-sm bg-nc-gold"></i>keep
      </span>
      <span class="flex items-center gap-1 text-[9px] text-nc-mut">
        <i class="inline-block h-1.5 w-1.5 rounded-sm bg-nc-red"></i>fumble
      </span>
      <span class="flex items-center gap-1 text-[9px] text-nc-mut">
        <i class="inline-block h-1.5 w-1.5 rounded-sm bg-nc-mut-2"></i>khamoshi
      </span>
    </div>
  </div>

  <!-- SCROLL AREA -->
  {#if !layout.timelineCollapsed}
    <div
      bind:this={wrap}
      bind:clientWidth={viewW}
      onscroll={(e) => (scrollLeft = e.currentTarget.scrollLeft)}
      class="nc-scroll min-h-0 overflow-x-auto overflow-y-hidden"
    >
      <div class="relative" style="width:{contentW}px">
        <!-- ruler -->
        <div
          {...aria}
          class="relative cursor-pointer border-b border-nc-line"
          style="height:{RULER_H}px"
          onclick={seekFromEvent}
          onkeydown={laneKeys}
        >
          {#each ticks as tick (tick.t)}
            <div
              class="absolute top-0 bottom-0 w-px {tick.major ? 'bg-nc-line-2' : 'bg-nc-line'}"
              style="left:{tick.t * zoom}px"
            ></div>
            {#if tick.major}
              <span
                class="absolute top-1 font-mono text-[9px] text-nc-mut"
                style="left:{tick.t * zoom + 3}px">{fmtShort(tick.t)}</span
              >
            {/if}
          {/each}
        </div>

        <!-- T lane (text overlays) — Clipchamp order: text on top -->
        <div
          {...aria}
          class="relative cursor-pointer border-b border-nc-line/60 bg-nc-panel"
          style="height:{TEXT_H}px"
          onclick={seekFromEvent}
          onkeydown={laneKeys}
        >
          <span
            class="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 font-serif text-[13px] text-nc-mut"
            >T</span
          >
          {#each project.texts as t (t.id)}
            <div
              class="absolute top-1 bottom-1 overflow-hidden rounded border border-nc-gold/40 bg-nc-gold/10 px-1.5 text-[10px] leading-[18px] text-nc-gold"
              style="left:{t.startSec * zoom}px;width:{(t.endSec - t.startSec) * zoom}px"
              title="{t.kind}: {t.text}"
            >
              <span class="truncate">{t.text}</span>
            </div>
          {/each}
        </div>

        <!-- video lane · real filmstrip on canvas, red hatched cut gaps behind -->
        <div
          {...aria}
          class="relative cursor-pointer border-b border-nc-line/60 bg-nc-bg"
          style="height:{VIDEO_H}px"
          onclick={seekFromEvent}
          onkeydown={laneKeys}
          title="Video lane — real 1 fps filmstrip. Kept ranges are solid, cut ranges are red hatched."
        >
          <canvas bind:this={backCanvas} class="absolute inset-0 block"></canvas>
          <canvas bind:this={filmCanvas} class="absolute inset-0 block"></canvas>
        </div>

        <!-- audio lane · waveform -->
        <div
          {...aria}
          class="relative cursor-pointer bg-nc-panel"
          style="height:{AUDIO_H}px"
          onclick={seekFromEvent}
          onkeydown={laneKeys}
          title="Audio lane — traffic-light waveform (gold keep · red fumble · grey silence)"
        >
          <canvas bind:this={waveCanvas} class="block" style="height:{AUDIO_H}px"></canvas>
          <span
            class="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-[11px] text-nc-mut"
            >♪</span
          >
        </div>

        <!-- playhead -->
        <div
          class="pointer-events-none absolute top-0 bottom-0 z-10 w-[2px] bg-nc-txt"
          style="left:{player.currentTime * zoom}px"
        ></div>
        <div
          class="pointer-events-none absolute z-20 h-3.5 w-3.5 -translate-x-1/2 rounded-full bg-nc-txt shadow-lg"
          style="left:{player.currentTime * zoom}px;top:{RULER_H - 14}px"
        ></div>
      </div>
    </div>
  {/if}

  <!-- floating bottom-right toolbar (Clipchamp's `fui-Toolbar`, 129.6 × 33.2) -->
  <div
    class="absolute right-3 bottom-2 z-20 flex items-center gap-0.5 rounded-lg border border-nc-line bg-nc-panel-2/95 p-0.5 backdrop-blur-sm"
  >
    <button
      onclick={() => nudgeZoom(-1)}
      class="grid h-7 w-7 place-items-center rounded text-nc-mut hover:bg-nc-line hover:text-nc-txt"
      title="Zoom out"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
      >
        <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4M8 11h6" />
      </svg>
    </button>
    <button
      onclick={() => nudgeZoom(1)}
      class="grid h-7 w-7 place-items-center rounded text-nc-mut hover:bg-nc-line hover:text-nc-txt"
      title="Zoom in"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
      >
        <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4M11 8v6M8 11h6" />
      </svg>
    </button>
    <button
      onclick={zoomFit}
      class="grid h-7 w-7 place-items-center rounded text-nc-mut hover:bg-nc-line hover:text-nc-txt"
      title="Zoom to fit"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
      </svg>
    </button>
    <span class="mx-0.5 h-4 w-px bg-nc-line"></span>
    <button
      onclick={() => (layout.timelineCollapsed = !layout.timelineCollapsed)}
      class="grid h-7 w-7 place-items-center rounded text-nc-mut hover:bg-nc-line hover:text-nc-txt"
      title="Collapse timeline"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        class="transition-transform {layout.timelineCollapsed ? 'rotate-180' : ''}"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  </div>
</section>
