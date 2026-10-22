<script lang="ts">
  import { player } from '../../stores/player.svelte';
  import { project } from '../../stores/project.svelte';
  import { thumbUrl } from '../../media';
  import { fmtTime } from '../../utils';
  import AmbientGlow from './AmbientGlow.svelte';

  let videoEl: HTMLVideoElement | null = $state(null);
  let stage: HTMLDivElement | null = $state(null);
  let scrubbing = false;

  const onLoaded = () => {
    const v = videoEl;
    if (!v) return;
    player.attach(v);
    if (project.media) {
      project.media.durationSecs = isFinite(v.duration) ? v.duration : project.media.durationSecs;
      project.media.width = v.videoWidth;
      project.media.height = v.videoHeight;
    }
    // Nudge the playhead so the first frame actually paints — with only
    // `preload="metadata"` the canvas can stay black.
    if (v.readyState >= 1) {
      try {
        v.currentTime = Math.min(0.08, (v.duration || 1) / 100);
      } catch {
        /* not seekable yet */
      }
    }
  };

  /**
   * Phantom Cut — the whole point of this app.
   * Playing never re-encodes; we just refuse to sit inside a ✕ range.
   */
  function onTimeUpdate() {
    const v = videoEl;
    if (!v || scrubbing) return;
    // A seek we just asked for may not have landed yet — this event still
    // carries the pre-seek position. Trusting it would undo the skip.
    if (player.isStaleUpdate(v.currentTime)) return;
    const corrected = project.skipCuts(v.currentTime);
    if (corrected !== v.currentTime) {
      scrubbing = true;
      v.currentTime = corrected;
      scrubbing = false;
      // The label must follow the frame the user is actually watching, not
      // the position the seek asked for.
      player.currentTime = corrected;
      return;
    }
    player.currentTime = v.currentTime;
    const idx = project.lineAt(v.currentTime);
    if (idx >= 0 && idx !== project.cursor) project.cursor = idx;
  }

  function onPlay() {
    player.playing = true;
  }
  function onPause() {
    player.playing = false;
  }

  // Re-sync after a seek from the timeline / keyboard.
  $effect(() => {
    const v = videoEl;
    const t = player.currentTime;
    if (!v || !project.media) return;
    if (Math.abs(v.currentTime - t) > 0.35) {
      scrubbing = true;
      v.currentTime = t;
      scrubbing = false;
    }
  });

  // Unregister on teardown so the element is not retained after mode switch.
  $effect(() => {
    return () => {
      if (player.el === videoEl) player.attach(null);
    };
  });

  function toggleFullscreen() {
    const s = stage;
    if (!s) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void s.requestFullscreen?.();
  }

  const curLine = $derived(project.lines[project.cursor]);
  const inCut = $derived(project.isCutAt(player.currentTime));
  /** The first filmstrip frame doubles as the poster, so the canvas is never black. */
  const poster = $derived(project.thumbnails ? thumbUrl(project.thumbnails, 0) : undefined);

  const currentSegment = $derived(
    project.segments.find(
      (s) => player.currentTime >= s.startSec && player.currentTime < s.endSec
    ) ?? null
  );

  const audioHidden = $derived(
    project.isTrackHidden('audio') ||
      (currentSegment ? project.isSegmentMuted(currentSegment.id) : false)
  );
  const videoHidden = $derived(project.isTrackHidden('video'));

  $effect(() => {
    const v = videoEl;
    if (!v) return;
    v.muted = audioHidden;
  });
</script>

<!-- PREVIEW STAGE — no toolbar; Clipchamp keeps the transport in the timeline row below -->
<div
  bind:this={stage}
  data-focus="stage"
  tabindex="-1"
  class="relative isolate grid min-h-0 flex-1 place-items-center overflow-hidden bg-nc-bg p-4 outline-none"
>
  {#if project.media}
    <!-- YouTube-style Ambient Mode glow: strictly BEHIND the 16:9 player,
         blooming outward from behind the player edges into the stage. The
         `isolate` above keeps `mix-blend-mode: screen` inside this stage —
         the glow can never tint the media or transcript panels. -->
    <div
      class="pointer-events-none absolute inset-0 z-0 grid place-items-center"
      aria-hidden="true"
    >
      <div
        class="aspect-video max-h-full w-full max-w-[min(100%,calc((100vh-330px)*16/9))] scale-[1.18]"
      >
        <AmbientGlow video={videoEl} {poster} />
      </div>
    </div>

    <!-- 16:9 frame that fits the stage, sitting in front of the ambient glow -->
    <div
      class="relative z-10 aspect-video max-h-full w-full max-w-[min(100%,calc((100vh-330px)*16/9))] overflow-hidden rounded bg-black shadow-lg ring-1 ring-white/5"
    >
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={videoEl}
        src={project.media.url}
        {poster}
        preload="auto"
        class="relative z-10 h-full w-full object-contain {videoHidden ? 'invisible' : ''}"
        onloadedmetadata={onLoaded}
        ontimeupdate={onTimeUpdate}
        onplay={onPlay}
        onpause={onPause}
        onclick={() => player.toggle()}
      ></video>

      {#if curLine?.keep === 'cut'}
        <div
          class="pointer-events-none absolute inset-0 z-20 border-2 border-nc-red/70"
          style="background:repeating-linear-gradient(45deg,transparent,transparent 10px,rgba(229,72,77,.14) 10px,rgba(229,72,77,.14) 20px)"
        ></div>
      {/if}

      <!-- status chip, top-left of the canvas -->
      <div class="pointer-events-none absolute top-2 left-2 z-20 flex max-w-[70%] flex-col gap-1">
        {#if inCut}
          <span
            class="w-fit rounded bg-nc-red/85 px-2 py-0.5 text-[10px] font-bold tracking-wider text-white"
            title="Playhead is inside a cut range — preview skips it"
          >
            ✕ CUT RANGE · SKIPPED
          </span>
        {/if}
        {#if curLine}
          <span
            class="truncate rounded bg-black/65 px-2 py-1 text-[11px] backdrop-blur-sm
                   {curLine.keep === 'keep' ? 'text-nc-green' : 'text-nc-red'}"
          >
            {curLine.keep === 'keep' ? '✓' : '✕'}
            {curLine.text}
          </span>
        {/if}
      </div>
    </div>

    <!-- fullscreen, bottom-right of the stage -->
    <button
      onclick={toggleFullscreen}
      class="absolute right-4 bottom-4 z-20 grid h-8 w-8 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
      title="Fullscreen"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5" />
      </svg>
    </button>
  {:else}
    <div class="max-w-md text-center">
      <div
        class="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-full border-2 border-nc-line bg-nc-panel"
      >
        <svg
          width="34"
          height="34"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          class="text-nc-brand"
        >
          <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
        </svg>
      </div>
      {#if project.loadError}
        <p class="text-sm font-semibold text-nc-red">Video load nahi hua.</p>
        <p class="mt-2 text-xs leading-relaxed text-nc-mut">{project.loadError}</p>
      {:else}
        <p class="text-sm font-semibold">Overtime nahi karna hai.</p>
        <p class="mt-2 text-xs leading-relaxed text-nc-mut">
          Koi video nahi khuli. Apni video load karne ke liye
          <b class="text-nc-brand">Media</b> mode pe jao.
        </p>
      {/if}
    </div>
  {/if}
</div>
