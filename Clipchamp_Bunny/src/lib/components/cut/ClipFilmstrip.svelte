<script lang="ts">
  /**
   * Filmstrip for a clip that came from My media.
   *
   * The main cut already shows the source frames (they are baked to disk by
   * `extract_thumbnails` and drawn on a canvas). An asset dropped on the
   * timeline has no baked strip — it is a separate file the user brought in —
   * so it used to render as a bare gradient block, which is exactly the
   * complaint in the handwritten sketch: "new clip also support drag & drop
   * etc like previews".
   *
   * This paints the real frames instead, one seek at a time, from a single
   * hidden `<video>` that is thrown away with the component. Nothing is
   * decoded into the Rust heap and nothing is buffered for the whole file:
   * the browser's own demuxer serves six small frames, and the canvas holds
   * the result. If the file cannot be read (codec, permissions) the gradient
   * underneath stays visible, so the block never turns into a black hole.
   */
  interface Props {
    /** Streamable URL — public path in the browser, asset protocol on desktop. */
    src: string;
    kind: 'video' | 'image';
    inSec: number;
    outSec: number;
    /** Rendered width of the block in px — decides how many frames fit. */
    width: number;
  }

  let { src, kind, inSec, outSec, width }: Props = $props();

  /** One tile's width. 44 px is roughly a 16:9 frame at lane height. */
  const TILE_W = 44;
  /** Never seek more than this per clip — each seek costs a decode. */
  const MAX_FRAMES = 8;
  /** Lane height; the component stretches, this is only the canvas buffer. */
  const H = 56;

  let canvas = $state<HTMLCanvasElement | null>(null);
  let video = $state<HTMLVideoElement | null>(null);
  let failed = $state(false);

  /** Generation counter: a zoom or trim during a paint cancels the old run. */
  let run = 0;

  /** Seek and resolve once the frame is actually available. */
  function seek(v: HTMLVideoElement, t: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        v.removeEventListener('seeked', finish);
        v.removeEventListener('error', finish);
        resolve();
      };
      v.addEventListener('seeked', finish);
      v.addEventListener('error', finish);
      const target = Math.min(Math.max(0, t), Math.max(0, (v.duration || 0) - 0.05));
      if (Math.abs(v.currentTime - target) < 0.01) {
        finish();
        return;
      }
      try {
        v.currentTime = target;
      } catch {
        finish();
        return;
      }
      // A seek that never fires (a broken file) must not wedge the effect.
      setTimeout(finish, 2500);
    });
  }

  async function paint() {
    const c = canvas;
    const v = video;
    if (!c) return;
    const id = ++run;
    // A 3-minute clip at 40 px/s is 7000 px wide. Buffering that many pixels
    // buys nothing - only the viewport is ever visible - so the strip paints
    // into a capped buffer and CSS stretches it across the block.
    const cssW = Math.max(1, width);
    if (cssW < 24) return; // too narrow to be worth a seek
    const bufW = Math.min(4096, Math.ceil(cssW));
    c.width = bufW;
    c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, bufW, H);

    // An image asset has no timeline inside it: one cover fill is the whole
    // story, and repeating it would pretend to be a video.
    if (kind === 'image') return;

    if (!v) return;
    const frames = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(bufW / TILE_W)));
    const span = Math.max(0.08, outSec - inSec);
    const slice = bufW / frames;
    // Frames keep their real aspect ratio and repeat to fill their slice, so
    // a wide block reads as a filmstrip instead of one monstrously stretched
    // picture.
    const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    const frameW = Math.max(8, H * aspect);

    for (let i = 0; i < frames; i++) {
      await seek(v, inSec + (span * (i + 0.5)) / frames);
      if (id !== run || !canvas) return;
      const from = i * slice;
      const to = from + slice;
      for (let x = from; x < to; x += frameW) {
        ctx.drawImage(v, x, 0, Math.min(frameW, to - x) + 0.5, H);
      }
    }
    failed = false;
  }

  /** Re-paint when the block changes width (zoom, trim, resize). */
  $effect(() => {
    // Touch every input so Svelte re-runs this effect.
    void src;
    void kind;
    void inSec;
    void outSec;
    void width;
    void canvas;
    void video;
    void paint();
  });
</script>

{#if kind === 'image'}
  <img {src} alt="" class="pointer-events-none absolute inset-0 h-full w-full object-cover" />
{:else}
  <canvas
    bind:this={canvas}
    class="pointer-events-none absolute inset-0 h-full w-full"
    style="display:{failed ? 'none' : 'block'}"
  ></canvas>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    bind:this={video}
    {src}
    muted
    playsinline
    preload="auto"
    class="hidden"
    onerror={() => (failed = true)}
    onloadedmetadata={() => void paint()}
  ></video>
{/if}
