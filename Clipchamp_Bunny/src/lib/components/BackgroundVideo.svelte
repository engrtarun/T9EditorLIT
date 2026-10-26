<script lang="ts">
  /**
   * THE BACKGROUND LAYER — the footage (or the user's own wallpaper) behind
   * every screen.
   *
   * It used to be a fixed piece of the design. It is now a setting the profile
   * menu can change, and the store (`stores/background.svelte.ts`) is the only
   * thing that decides *what* is painted. This component only decides *when*
   * it is painted and keeps the zero-RAM promise:
   *
   *   · the bytes are **never** fetched into the page — no `fetch()`, no
   *     blob, no data URL. The store holds a *path*, and the webview streams
   *     the file through Tauri's `asset://` protocol, which answers HTTP
   *     `Range` requests by seeking in the file, so only the chunk being
   *     decoded is in memory at any moment. `loop` then seeks back to frame 0
   *     instead of re-downloading anything;
   *   · playback stops when the window is hidden or minimised, and also when
   *     the editor takes over — there it is covered by opaque panels anyway,
   *     so decoding it would be pure waste on a low-spec machine;
   *   · playback also stays off when the OS says "reduce motion"
   *     (`prefers-reduced-motion`), leaving the poster frame on screen. A
   *     wallpaper is decoration; motion sickness and battery life both win;
   *   · a still wallpaper is allowed instead of a video, and it costs no
   *     decoding at all — that is the cheapest background this app can paint.
   *
   * If the file is missing or refuses to decode, the layer falls back to the
   * poster and then to a static gradient — never an empty rectangle.
   */
  import { onMount } from 'svelte';
  import { app } from '../stores/app.svelte';
  import { background } from '../stores/background.svelte';

  let video = $state<HTMLVideoElement | null>(null);
  /** The file is gone or refuses to decode. */
  let failed = $state(false);
  /** `document.visibilityState`, mirrored into reactive state. */
  let visible = $state(true);
  /** The OS "reduce motion" setting. */
  let calm = $state(false);

  onMount(() => {
    visible = document.visibilityState === 'visible';
    const onVisibility = () => (visible = document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    calm = motion.matches;
    const onMotion = (e: MediaQueryListEvent) => (calm = e.matches);
    motion.addEventListener('change', onMotion);

    void background.refresh();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      motion.removeEventListener('change', onMotion);
    };
  });

  // A new file is a new element: a fresh `src` on the old one would keep the
  // decoder (and its buffers) alive for a file nobody is watching.
  let seen = 0;
  $effect(() => {
    if (background.rev !== seen) {
      seen = background.rev;
      failed = false;
    }
  });

  /**
   * The one place playback is decided: play only when the file is there, the
   * window is visible, motion is welcome and the background is on screen.
   */
  $effect(() => {
    const el = video;
    if (!el) return;
    const shouldPlay = !!background.src && !failed && visible && !calm && app.view === 'home';
    if (shouldPlay) {
      // Autoplay is muted-only; the attribute is set in markup too, but the
      // property is what guarantees it before the first `play()`.
      el.muted = true;
      void el.play().catch(() => {
        /* a blocked play() resolves itself on the first real interaction */
      });
    } else {
      el.pause();
    }
  });
</script>

<!--
  Fixed to the viewport, behind everything (negative z-index), `object-cover`
  so any window size or aspect ratio fills without stretching, and no filter of
  any kind: the footage keeps its own colours.
-->
<div class="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
  {#if background.ready && background.src && !failed}
    {#if background.kind === 'image'}
      <img
        src={background.src}
        class="h-full w-full object-cover"
        alt=""
        decoding="async"
        onerror={() => (failed = true)}
      />
    {:else}
      {#key background.rev}
        <video
          bind:this={video}
          src={background.src}
          poster={background.poster || undefined}
          class="h-full w-full object-cover"
          autoplay
          muted
          loop
          playsinline
          preload="metadata"
          disablepictureinpicture
          disableremoteplayback
          onerror={() => (failed = true)}
        ></video>
      {/key}
    {/if}
  {/if}

  <!--
    A fixed, subtle readability gradient — part of the interface, not a video
    effect (it never changes with the footage). Heavier at the very top and
    bottom where the chrome and the dashboard copy sit, almost transparent over
    the middle of the frame, so the subject stays clear.
  -->
  <div
    class="absolute inset-0"
    style="background: linear-gradient(
      180deg,
      rgb(8 10 14 / 0.55) 0%,
      rgb(8 10 14 / 0.16) 24%,
      rgb(8 10 14 / 0.1) 62%,
      rgb(8 10 14 / 0.46) 100%
    )"
  ></div>

  {#if failed || (background.ready && !background.src)}
    <!-- Static fallback: the brand's own dark surface, quietly tinted. -->
    <div
      class="absolute inset-0"
      style="background:
        radial-gradient(120% 90% at 78% 18%, rgb(77 141 255 / 0.18), transparent 62%),
        linear-gradient(160deg, #15171b 0%, #1a1d24 55%, #141620 100%)"
    ></div>
  {/if}
</div>
