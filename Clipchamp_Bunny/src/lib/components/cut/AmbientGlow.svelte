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
   *   6. Before the first video frame is decodable (a paused project, a cold
   *      `preload`), the cached poster is sampled instead — the glow is never
   *      an empty black box while the player is waiting.
   *
   * Zero-RAM design (repo directive): the only buffer is one 48x27 * 4 bytes
   * ≈ 5 KB canvas. No frame queue, no ImageData, no read-back, no images —
   * new frames are alpha-blended into the existing canvas (exponential
   * moving average), which is why colour transitions glide instead of
   * snapping between samples.
   */
  let { video, poster = null }: { video: HTMLVideoElement | null; poster?: string | null } =
    $props();

  // 16:9 sample buffer. Tiny on purpose — dominant colours only (~5 KB RAM).
  const W = 48;
  const H = 27;
  const FRAME_MS = 100; // ~10 fps sampling throttle, like YouTube's loop
  const NEW_FRAME_ALPHA = 0.25; // per-tick blend weight (glow responsiveness)

  let canvas: HTMLCanvasElement | null = $state(null);

  // Soft atmospheric bloom. `screen` is the important bit: black pixels add
  // nothing to the page, so only the video's actual colours glow — the canvas
  // never paints a dark rectangle over the stage.
  const style =
    'opacity:.85;mix-blend-mode:screen;filter:blur(56px) saturate(1.6) brightness(1.15);' +
    '-webkit-mask-image:radial-gradient(ellipse at center,#000 58%,rgba(0,0,0,.55) 82%,transparent 100%);' +
    'mask-image:radial-gradient(ellipse at center,#000 58%,rgba(0,0,0,.55) 82%,transparent 100%)';

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
    let videoPainted = false; // once true, the poster seed must never win
    let disposed = false; // a late poster decode must not paint a new project

    /**
     * Show the cached still until the decoder gives us a real frame.
     *
     * Opening a project leaves the video paused at `readyState < 2` for a
     * moment. Without this the glow would sit black exactly while the user is
     * looking at the new screen — the one moment the effect is supposed to
     * make the app feel warm and instant.
     */
    const seedPoster = () => {
      if (!poster || videoPainted) return;
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (disposed || videoPainted) return;
        try {
          ctx.globalAlpha = 1;
          ctx.drawImage(img, 0, 0, W, H);
        } catch {
          /* poster could not be decoded — the first video frame still will */
        }
      };
      img.src = poster;
    };

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
        videoPainted = true;
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
    // the new source is already buffered. Otherwise the cached poster holds
    // the glow until the live frame decodes.
    if (v.readyState >= 2) onFrame();
    seedPoster();

    return () => {
      disposed = true;
      stop();
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPark);
      v.removeEventListener('ended', onPark);
      v.removeEventListener('loadeddata', onFrame);
      v.removeEventListener('seeked', onFrame);
    };
  });
</script>

<!-- behind everything; fades out softly so nothing bleeds into neighbouring panels -->
<canvas
  bind:this={canvas}
  width={W}
  height={H}
  aria-hidden="true"
  class="pointer-events-none absolute inset-0 h-full w-full"
  {style}
></canvas>
