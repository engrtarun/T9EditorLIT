<script lang="ts">
  import { project } from '../../stores/project.svelte';
  import { player } from '../../stores/player.svelte';
  import { clamp, fmtShort, niceStep } from '../../utils';

  const WAVE_H = 54;
  const FPS_W = 34;
  const TEXT_H = 30;

  let wrap: HTMLDivElement | null = $state(null);
  let canvas: HTMLCanvasElement | null = $state(null);
  let scrollLeft = $state(0);
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

  const fpsTiles = $derived.by(() => {
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
    c.height = WAVE_H;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#14151d';
    ctx.fillRect(0, 0, w, WAVE_H);

    const mid = WAVE_H / 2;
    for (let px = 0; px < w; px += 2) {
      const sec = px / zoom;
      const pi = Math.min(peaks.length - 1, Math.floor((sec / project.durationSec) * peaks.length));
      const p = peaks[Math.max(0, pi)] ?? 0;
      const hgt = Math.max(1, p * (WAVE_H - 8));
      const ci = Math.min(colours.length - 1, Math.floor(sec / bucket));
      ctx.fillStyle = colours[ci] ?? '#3a3d4c';
      ctx.fillRect(px, mid - hgt / 2, 2, hgt);
    }

    // centre line
    ctx.fillStyle = '#2a2c38';
    ctx.fillRect(0, mid, w, 1);
  }

  $effect(() => {
    // re-run whenever the wave data, zoom, width or cut decisions change
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
    player.seek(clamp((e.clientX - rect.left) / zoom, 0, project.durationSec));
  }

  /** Keyboard equivalent so the lanes are reachable without a mouse. */
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

<!-- BOTTOM BOX: ruler · audio waves · fps strip · text lane -->
<section class="flex h-[38%] min-h-[250px] shrink-0 flex-col border-t border-nc-line bg-nc-panel">
  <!-- toolbar -->
  <div class="flex h-9 shrink-0 items-center gap-2 border-b border-nc-line px-2">
    <span class="text-[10px] font-bold tracking-widest text-nc-mut">TIMELINE</span>
    <span class="h-3 w-px bg-nc-line"></span>
    <span class="flex items-center gap-1 text-[10px] text-nc-mut">
      <i class="inline-block h-2 w-2 rounded-sm bg-nc-gold"></i> keep
    </span>
    <span class="flex items-center gap-1 text-[10px] text-nc-mut">
      <i class="inline-block h-2 w-2 rounded-sm bg-nc-red"></i> fumble / galat
    </span>
    <span class="flex items-center gap-1 text-[10px] text-nc-mut">
      <i class="inline-block h-2 w-2 rounded-sm bg-nc-mut-2"></i> khamoshi
    </span>

    <div class="flex-1"></div>
    <span class="font-mono text-[10px] text-nc-mut-2">view {viewW}px</span>
    <button
      onclick={() => nudgeZoom(-1)}
      class="rounded px-1.5 py-0.5 text-xs text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
      title="Zoom out">−</button
    >
    <button
      onclick={() => nudgeZoom(1)}
      class="rounded px-1.5 py-0.5 text-xs text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
      title="Zoom in">+</button
    >
    <button
      onclick={() => (player.zoom = 35)}
      class="rounded px-1.5 py-0.5 text-[10px] text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
      title="Reset zoom">fit</button
    >
  </div>

  <!-- scroller -->
  <div
    bind:this={wrap}
    bind:clientWidth={viewW}
    onscroll={(e) => (scrollLeft = e.currentTarget.scrollLeft)}
    class="nc-scroll min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
  >
    <div class="relative" style="width:{contentW}px">
      <!-- ruler -->
      <div
        {...aria}
        class="relative h-6 cursor-pointer border-b border-nc-line"
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

      <!-- audio wave (canvas — never thousands of DOM nodes) -->
      <canvas bind:this={canvas} class="block" style="height:{WAVE_H}px"></canvas>

      <!-- video lane · fps thumbnails -->
      <div
        {...aria}
        class="relative cursor-pointer border-y border-nc-line bg-nc-bg"
        style="height:{FPS_W}px"
        onclick={seekFromEvent}
        onkeydown={laneKeys}
        title="Video lane — 1 fps thumbnails (Rust extract_thumbnails fills these)"
      >
        {#each fpsTiles as t (t)}
          <div
            class="absolute top-1 bottom-1 rounded-[3px] border border-nc-line"
            style="left:{t * zoom + 1}px;width:{Math.max(2, zoom - 2)}px;
                   background:repeating-linear-gradient(45deg,#1a1c26,#1a1c26 4px,#20222e 4px,#20222e 8px);
                   opacity:{project.isCutAt(t) ? 0.25 : 0.9}"
          ></div>
        {/each}
      </div>

      <!-- text lane -->
      <div
        {...aria}
        class="relative cursor-pointer bg-nc-panel"
        style="height:{TEXT_H}px"
        onclick={seekFromEvent}
        onkeydown={laneKeys}
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
        {#if project.texts.length === 0}
          <span class="absolute left-3 top-1.5 text-[10px] text-nc-mut-2"
            >+ add text / zoom clip (Mode 3)</span
          >
        {/if}
      </div>

      <!-- playhead -->
      <div
        class="pointer-events-none absolute top-0 bottom-0 z-10 w-[2px] bg-nc-txt"
        style="left:{player.currentTime * zoom}px"
      ></div>
    </div>
  </div>
</section>
