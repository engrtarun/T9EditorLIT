<script lang="ts">
  import { project } from '../../stores/project.svelte';
  import { player } from '../../stores/player.svelte';
  import { clamp, fmtShort, fmtTime, niceStep } from '../../utils';

  /* Clipchamp timeline metrics, measured on the OBS capture (1280x720 frame):
     tool row 30px · ruler 26px · T lane 30px · video lane 58px · audio lane 44px */
  const RULER_H = 26;
  const TEXT_H = 30;
  const VIDEO_H = 58;
  const AUDIO_H = 44;

  let wrap: HTMLDivElement | null = $state(null);
  let canvas: HTMLCanvasElement | null = $state(null);
  let viewW = $state(1200);

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

  /* Colour per 0.25 s bucket, precomputed once — keeps the canvas draw cheap.
     gold = keep · red = fumble/repeat/galat · grey = khamoshi */
  const bucket = 0.25;
  const colours = $derived.by(() => {
    const n = Math.ceil((project.durationSec + 4) / bucket);
    const out = new Array<string>(n).fill('#3a3d4c');
    for (const l of project.lines) {
      const c = l.flag === 'silence' ? '#4a4d5c' : l.keep === 'cut' ? '#e5484d' : '#d4af37';
      const from = Math.max(0, Math.floor(l.startSec / bucket));
      const to = Math.min(n - 1, Math.ceil(l.endSec / bucket));
      for (let i = from; i <= to; i++) out[i] = c;
    }
    return out;
  });

  /** One filmstrip tile per second of source. */
  const filmTiles = $derived.by(() => {
    const out: number[] = [];
    for (let t = 0; t <= project.durationSec; t += 1) out.push(t);
    return out;
  });

  function drawWave() {
    const c = canvas;
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
    for (let px = 0; px < w; px += 2) {
      const sec = px / zoom;
      const pi = Math.min(peaks.length - 1, Math.floor((sec / project.durationSec) * peaks.length));
      const p = peaks[Math.max(0, pi)] ?? 0;
      const hgt = Math.max(1, p * (AUDIO_H - 10));
      const ci = Math.min(colours.length - 1, Math.floor(sec / bucket));
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
    void project.keptCount;
    void project.cutCount;
    drawWave();
  });

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
    if (project.splitAt(player.currentTime)) {
      player.seek(project.snapTime(player.currentTime));
    }
  }

  $effect(() => {
    const w = wrap;
    if (!w) return;
    viewW = w.clientWidth;
    const obs = new ResizeObserver(() => (viewW = w.clientWidth));
    obs.observe(w);
    return () => obs.disconnect();
  });

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

<!-- BOTTOM BLOCK — Clipchamp's timeline: tool row (tools · transport · zoom) then ruler + lanes -->
<section class="flex h-[38%] min-h-[252px] shrink-0 flex-col border-t border-nc-line bg-nc-panel">
  <!-- TOOL ROW: tools on the left, transport centred, zoom on the right -->
  <div class="relative flex h-[30px] shrink-0 items-center gap-1 border-b border-nc-line px-2">
    <!-- left tools -->
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

    <!-- centred transport (Clipchamp puts it here — right above the ruler) -->
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

    <!-- right: legend + zoom -->
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
      <span class="h-4 w-px bg-nc-line"></span>
      <button
        onclick={() => nudgeZoom(-1)}
        class="grid h-7 w-7 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
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
        class="grid h-7 w-7 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
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
        class="grid h-7 w-7 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
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
    </div>
  </div>

  <!-- SCROLL AREA -->
  <div
    bind:this={wrap}
    bind:clientWidth={viewW}
    class="nc-scroll min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
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

      <!-- video lane · filmstrip -->
      <div
        {...aria}
        class="relative cursor-pointer border-b border-nc-line/60 bg-nc-bg"
        style="height:{VIDEO_H}px"
        onclick={seekFromEvent}
        onkeydown={laneKeys}
        title="Video lane — 1 fps thumbnails (Rust extract_thumbnails fills these)"
      >
        {#each filmTiles as t, i (t)}
          <div
            class="absolute top-1 bottom-1 overflow-hidden rounded-[2px] border"
            style="left:{t * zoom + 1}px;width:{Math.max(2, zoom - 2)}px;
                   background:linear-gradient(155deg, hsl({210 +
              (i % 7) * 4} 16% 26%), hsl(222 20% 16%));
                   border-color:{project.isCutAt(t) ? '#2a2c38' : '#33363f'};
                   opacity:{project.isCutAt(t) ? 0.3 : 1}"
          ></div>
        {/each}
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
        <canvas bind:this={canvas} class="block" style="height:{AUDIO_H}px"></canvas>
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
</section>
