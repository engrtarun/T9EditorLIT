<script lang="ts">
  /**
   * THE BACKGROUND VIDEO — part of the interface's visual design, not a
   * setting. It sits behind every screen, plays silently, loops forever, and
   * is never configurable (no toggle, no upload, no brightness, no blur —
   * those would turn a piece of the design into a feature nobody asked for).
   *
   * The zero-RAM rule applies to it like everything else in this app:
   *
   *   · the bytes are **never** fetched into the page — no `fetch()`, no
   *     blob, no data URL. The desktop app resolves a *path* and the webview
   *     streams the file through Tauri's `asset://` protocol, which answers
   *     HTTP `Range` requests by seeking in the file, so only the chunk being
   *     decoded is in memory at any moment. `loop` then seeks back to frame 0
   *     instead of re-downloading anything;
   *   · the `src` is resolved **once**, on mount. Resizing, maximising and
   *     switching modes only change CSS (`object-cover`), so the element is
   *     never rebuilt and the video never reloads;
   *   · playback stops when the window is hidden or minimised, and also when
   *     the editor takes over — there it is covered by opaque panels anyway,
   *     so decoding it would be pure waste on a low-spec machine.
   *
   * If the file is missing, the layer falls back to a static gradient rather
   * than an empty rectangle.
   */
  import { onMount } from 'svelte';
  import { app } from '../stores/app.svelte';
  import { assetUrl, backgroundVideoPath, isTauri, logAppEvent } from '../ipc';

  /** The bundled copy — what the browser dev server serves. */
  const PUBLIC_SRC = '/assets/leatTokyo.mp4';

  let video = $state<HTMLVideoElement | null>(null);
  /** Set once, on mount. Never re-resolved afterwards. */
  let src = $state('');
  /** The file is nowhere to be found (or refused to decode). */
  let failed = $state(false);
  /** `document.visibilityState`, mirrored into reactive state. */
  let visible = $state(true);

  function giveUp(where: string) {
    if (failed) return;
    failed = true;
    // An absent background is worth knowing about, but it must never be a
    // crash or a dialog — the app simply keeps its static background.
    try {
      void logAppEvent('warn', 'background', `background video unavailable (${where})`);
    } catch {
      /* browser mode has no daemon to tell */
    }
  }

  onMount(() => {
    visible = document.visibilityState === 'visible';
    const onVisibility = () => (visible = document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);

    let alive = true;
    void (async () => {
      if (isTauri()) {
        const path = await backgroundVideoPath().catch(() => null);
        if (!alive) return;
        if (!path) return giveUp('no path on disk');
        src = assetUrl(path);
      } else {
        src = PUBLIC_SRC;
      }
    })();

    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  /**
   * The one place playback is decided: play only when the file is there, the
   * window is visible and the background is actually on screen.
   */
  $effect(() => {
    const el = video;
    if (!el) return;
    const shouldPlay = !!src && !failed && visible && app.view === 'home';
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
  {#if src && !failed}
    <video
      bind:this={video}
      {src}
      class="h-full w-full object-cover"
      autoplay
      muted
      loop
      playsinline
      preload="metadata"
      disablepictureinpicture
      disableremoteplayback
      onerror={() => giveUp('load error')}
    ></video>
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

  {#if failed}
    <!-- Static fallback: the brand's own dark surface, quietly tinted. -->
    <div
      class="absolute inset-0"
      style="background:
        radial-gradient(120% 90% at 78% 18%, rgb(77 141 255 / 0.18), transparent 62%),
        linear-gradient(160deg, #15171b 0%, #1a1d24 55%, #141620 100%)"
    ></div>
  {/if}
</div>
