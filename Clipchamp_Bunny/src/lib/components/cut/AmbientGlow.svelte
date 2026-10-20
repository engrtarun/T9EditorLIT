<script lang="ts">
  /**
   * YouTube-style Ambient Mode (a.k.a. YouTube's `cinematicmode`).
   *
   * How YouTube's real implementation works, mirrored here:
   *   1. A canvas sits BEHIND the player inside the same container.
   *   2. Every ~100 ms the current video frame is downscaled onto a tiny
   *      canvas — downscaling IS the colour sampling: dominant hues survive,
   *      fine detail drops. YouTube's own canvas is ~10x6 px; we use 48x27.
   *   3. The canvas is stretched to full size and blurred, saturated with CSS
   *      filters, then masked with an elliptical falloff so the glow blooms
   *      outwards and fades before the container edge.
   *   4. `requestAnimationFrame` loop only while the video plays; on pause /
   *      ended the loop stops (CPU drops to zero) and the last frame stays.
   *   5. `prefers-reduced-motion: reduce` disables the effect entirely.
   *
   * Zero-RAM design (repo directive): the only buffer is one 48x27 * 4 bytes
   * ≈ 5 KB canvas. No frame queue, no ImageData, no read-back, no images —
   * new frames are alpha-blended into the existing canvas (exponential
   * moving average), which is why colour transitions glide instead of
   * snapping between samples.
   */
  let { video }: { video: HTMLVideoElement | null } = $props();

  // 16:9 sample buffer. Tiny on purpose — dominant colours only.
  const W = 48;
  const H = 27;
  const FRAME_MS = 100; // ~10 fps sampling throttle, like YouTube's loop
  const NEW_FRAME_ALPHA = 0.25; // per-tick blend weight (glow responsiveness)

  let canvas: HTMLCanvasElement | null = $state(null);

  $effect(() => {
    const v = video;
    const c = canvas;
    if (!v || !c) return;

    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) return;

    // Decorative only — motion-sensitive users get zero sampling.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // Prime with black so the glow ramps up from nothing, muted.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    let raf = 0;
    let last = -Infinity;
    let running = false;
    let primed = false; // first frame lands at full strength, no ramp

    const paint = () => {
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      if (v.readyState < 2 || vw === 0 || vh === 0) return;

      // Sample the CONTENT region only (`object-cover` maths). A letterboxed
      // frame would drag black bars into the sample and drown the whole glow
      // in black — vertical clips would otherwise glow at nothing.
      const target = W / H;
      const src = vw / vh;
      let sw = vw;
      let sh = vh;
      let sx = 0;
      let sy = 0;
      if (src > target) {
        // video wider than the buffer — crop the sides
        sw = vh * target;
        sx = (vw - sw) / 2;
      } else {
        // video taller than the buffer — crop top + bottom
        sh = vw / target;
        sy = (vh - sh) / 2;
      }

      // Alpha-blend the new frame into the old one — the ambient ramp is
      // smooth even when scene colours change abruptly. The very first
      // frame lands at full strength so the glow appears instantly.
      if (!primed) {
        primed = true;
        ctx.globalAlpha = 1;
      } else {
        ctx.globalAlpha = NEW_FRAME_ALPHA;
      }
      try {
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
      } catch {
        /* frame not decodable this tick — harmless, next tick retries */
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      if (!running) return;
      if (now - last >= FRAME_MS) {
        last = now;
        paint();
      }
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running) return;
      running = true;
      last = -Infinity; // paint immediately on (re)start
      raf = requestAnimationFrame(tick);
    };

    // Keeps the last painted frame on screen, then cancels the loop.
    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const onPlay = start;
    const onPark = stop; // pause + ended: freeze, don't spend CPU
    const onFrame = paint; // loadeddata + seeked: single one-off draw

    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPark);
    v.addEventListener('ended', onPark);
    v.addEventListener('loadeddata', onFrame);
    v.addEventListener('seeked', onFrame);

    // A clip edit re-points `src` on the same element — repaint once when
    // the new source is already buffered.
    if (v.readyState >= 2) onFrame();

    return () => {
      stop();
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPark);
      v.removeEventListener('ended', onPark);
      v.removeEventListener('loadeddata', onFrame);
      v.removeEventListener('seeked', onFrame);
    };
  });
</script>

<!-- behind everything in the stage; the media box covers the centre and the
     glow blooms out into the stage padding. Masked so nothing bleeds onto
     the neighbouring panels. -->
<canvas
  bind:this={canvas}
  width={W}
  height={H}
  aria-hidden="true"
  class="pointer-events-none absolute inset-0 h-full w-full"
  style="opacity:.75;filter:blur(96px) saturate(1.4) brightness(1);-webkit-mask-image:radial-gradient(ellipse at center,#000 55%,transparent 96%);mask-image:radial-gradient(ellipse at center,#000 55%,transparent 96%)"
></canvas>
