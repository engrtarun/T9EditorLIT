<script lang="ts">
  import { untrack } from 'svelte';
  import { player } from '../../stores/player.svelte';
  import { project } from '../../stores/project.svelte';
  import { thumbUrl } from '../../media';
  import { fmtTime } from '../../utils';
  import AmbientGlow from './AmbientGlow.svelte';

  let videoEl: HTMLVideoElement | null = $state(null);
  let stage: HTMLDivElement | null = $state(null);
  let scrubbing = false;
  /** True while we swap the source ourselves — the pause it causes is not the user's. */
  let switching = false;
  /** Playback should continue after the next clip's metadata lands. */
  let resume = false;

  /** The extra clip being previewed, or null while the main cut plays. */
  const activeClip = $derived(project.activeClip);
  const isImage = $derived(activeClip?.kind === 'image');
  /** The file this frame is showing: the main source or the active clip. */
  const src = $derived(activeClip?.url ?? project.media?.url ?? '');

  /**
   * A new clip reuses the same `<video>` element, so the browser starts the
   * new file at 0. The playhead already knows where it wants to be - seek
   * there as soon as the metadata lands, then keep playing if it was playing.
   */
  const onLoaded = () => {
    const v = videoEl;
    if (!v || isImage) return;
    player.attach(v);
    if (project.media && !activeClip) {
      project.media.durationSecs = isFinite(v.duration) ? v.duration : project.media.durationSecs;
      project.media.width = v.videoWidth;
      project.media.height = v.videoHeight;
    }
    const want = untrack(() => player.currentTime);
    const dur = isFinite(v.duration) ? v.duration : 0;
    try {
      if (want > 0.01) {
        v.currentTime = dur > 0 ? Math.min(want, Math.max(0, dur - 0.05)) : want;
      } else {
        // Nudge the playhead so the first frame actually paints - with only
        // `preload="metadata"` the canvas can stay black.
        v.currentTime = Math.min(0.08, (dur || 1) / 100);
      }
    } catch {
      /* not seekable yet */
    }
    // `advance()` arms `resume` before the swap: the next clip starts playing
    // as soon as its metadata is in, exactly like the clip before it. A swap
    // can also fire `pause` *after* this callback, so `resume` stays armed
    // until `onPlay` confirms the element actually restarted.
    const wants = untrack(() => player.playing) || resume;
    if (wants) {
      void v.play().catch(() => {
        switching = false;
        resume = false;
        player.playing = false;
      });
    } else {
      switching = false;
    }
  };

  /**
   * Phantom Cut - the whole point of this app.
   * Playing never re-encodes; we just refuse to sit inside a cut range.
   * Extra clips have no transcript, so they play exactly as they are.
   */
  function onTimeUpdate() {
    const v = videoEl;
    if (!v || scrubbing) return;
    // A seek we just asked for may not have landed yet - this event still
    // carries the pre-seek position. Trusting it would undo the skip.
    if (player.isStaleUpdate(v.currentTime)) return;

    if (!activeClip) {
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
      // With extra clips on the timeline the main cut hands over the moment
      // the last kept second plays: trailing cut material belongs to neither.
      if (project.clips.length && mainEndSec > 0 && v.currentTime >= mainEndSec - 0.03) {
        advance();
        return;
      }
      const idx = project.lineAt(v.currentTime);
      if (idx >= 0 && idx !== project.cursor) project.cursor = idx;
    } else if (activeClip.kind === 'video' && v.currentTime >= activeClip.outSec - 0.04) {
      // The clip's out-point: the project moves on to the next clip.
      advance();
      return;
    }

    player.currentTime = v.currentTime;
  }

  /**
   * Move to the next clip in the project, or stop at the end.
   *
   * `activateClip` swaps the preview source and puts the playhead at that
   * clip's in-point; `onLoaded` then starts playback if it was playing.
   */
  function advance() {
    const next = project.nextClipId();
    if (!next) {
      if (activeClip) player.currentTime = activeClip.outSec;
      resume = false;
      switching = false;
      player.playing = false;
      videoEl?.pause();
      return;
    }
    // A source swap pauses the element; that pause is ours, not the user's.
    switching = true;
    resume = player.playing || videoEl?.ended === true;
    project.activateClip(next);
    player.playing = resume;
  }

  function onPlay() {
    switching = false;
    resume = false;
    player.playing = true;
  }
  /**
   * The element pauses for two very different reasons: the user pressed pause,
   * or a new source was loaded for the next clip. Only the first one stops the
   * project - the second is the seam between two clips.
   */
  function onPause() {
    if (switching || resume) return;
    player.playing = false;
  }

  // Re-sync after a seek from the timeline / keyboard.
  $effect(() => {
    const v = videoEl;
    const t = player.currentTime;
    void src;
    if (!v || !project.media || isImage) return;
    if (Math.abs(v.currentTime - t) > 0.35) {
      scrubbing = true;
      v.currentTime = t;
      scrubbing = false;
    }
  });

  // An image clip has no <video>; make sure the player is not holding a
  // detached element (Space would otherwise try to play a dead video).
  $effect(() => {
    if (isImage) player.attach(null);
  });

  /**
   * A still clip has no clock of its own: 100 ms ticks move the playhead from
   * its in-point to its out-point, then the project advances.
   */
  $effect(() => {
    const clip = activeClip;
    if (!clip || clip.kind !== 'image' || !player.playing) return;
    const from = untrack(() => player.currentTime);
    const startedAt = performance.now();
    const timer = setInterval(() => {
      const t = from + (performance.now() - startedAt) / 1000;
      if (t >= clip.outSec) {
        player.currentTime = clip.outSec;
        clearInterval(timer);
        advance();
      } else {
        player.currentTime = t;
      }
    }, 100);
    return () => clearInterval(timer);
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

  const curLine = $derived(activeClip ? undefined : project.lines[project.cursor]);
  const inCut = $derived(!activeClip && project.isCutAt(player.currentTime));
  /** The first filmstrip frame doubles as the poster, so the canvas is never black. */
  const poster = $derived(
    activeClip ? undefined : project.thumbnails ? thumbUrl(project.thumbnails, 0) : undefined
  );

  const currentSegment = $derived(
    activeClip
      ? null
      : (project.segments.find(
          (s) => player.currentTime >= s.startSec && player.currentTime < s.endSec
        ) ?? null)
  );

  const audioHidden = $derived(
    project.isTrackHidden('audio') ||
      (currentSegment ? project.isSegmentMuted(currentSegment.id) : false)
  );
  const videoHidden = $derived(project.isTrackHidden('video'));
  const clipTimeLeft = $derived(
    activeClip ? Math.max(0, activeClip.outSec - player.currentTime) : 0
  );

  /** The last kept source second - where the main cut ends. */
  const mainEndSec = $derived.by(() => {
    const segs = project.orderedSegments;
    return segs.length ? Math.max(...segs.map((s) => s.endSec)) : 0;
  });

  $effect(() => {
    const v = videoEl;
    if (!v) return;
    v.muted = audioHidden;
  });
</script>

<!-- PREVIEW STAGE - no toolbar; Clipchamp keeps the transport in the timeline row below -->
<div
  bind:this={stage}
  data-focus="stage"
  tabindex="-1"
  class="relative isolate grid min-h-0 flex-1 place-items-center overflow-hidden bg-nc-bg p-4 outline-none"
>
  {#if project.media}
    <!-- YouTube-style Ambient Mode glow: strictly BEHIND the 16:9 player,
         blooming outward from behind the player edges into the stage. The
         `isolate` above keeps `mix-blend-mode: screen` inside this stage -
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
      {#if isImage && activeClip}
        <!-- A still clip: no decoder, just the picture for its clip length. -->
        <button
          type="button"
          class="relative z-10 block h-full w-full cursor-pointer {videoHidden ? 'invisible' : ''}"
          onclick={() => player.toggle()}
          aria-label="Play / pause {activeClip.name}"
        >
          <img src={activeClip.url} alt={activeClip.name} class="h-full w-full object-contain" />
        </button>
      {:else}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={videoEl}
          {src}
          {poster}
          preload="auto"
          class="relative z-10 h-full w-full object-contain {videoHidden ? 'invisible' : ''}"
          onloadedmetadata={onLoaded}
          ontimeupdate={onTimeUpdate}
          onplay={onPlay}
          onpause={onPause}
          onended={advance}
          onclick={() => player.toggle()}
        ></video>
      {/if}

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
            class="w-fit rounded bg-nc-red/40 px-2 py-0.5 text-[10px] font-bold tracking-wider text-white backdrop-blur-md"
            title="Playhead is inside a cut range - preview skips it"
          >
            ✕ CUT RANGE · SKIPPED
          </span>
        {/if}
        {#if activeClip}
          <span
            class="w-fit rounded bg-nc-brand/85 px-2 py-0.5 text-[10px] font-semibold text-nc-bg"
            title="This clip is on the timeline but has no transcript; it plays as-is"
          >
            ▶ {activeClip.name} · {fmtTime(clipTimeLeft)} left
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
