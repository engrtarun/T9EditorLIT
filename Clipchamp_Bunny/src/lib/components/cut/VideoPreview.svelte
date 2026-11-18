<script lang="ts">
  import { untrack } from 'svelte';
  import { player } from '../../stores/player.svelte';
  import { project } from '../../stores/project.svelte';
  import { thumbUrl } from '../../media';
  import { fmtShort, fmtTime } from '../../utils';
  import { framePreset } from '../../project-frame';
  import { watchWordSelection, wordCount, type WordSelection } from '../../word-selection';
  import { wordCutPreview } from '../../stores/wordCutPreview.svelte';
  import { toast } from '../../stores/toast.svelte';
  import AmbientGlow from './AmbientGlow.svelte';
  import WordCutToolbar from './WordCutToolbar.svelte';

  /**
   * The project's shape, as chosen in "Create New Project".
   *
   * A vertical project must *look* vertical in the preview — the export canvas
   * letterboxes the picture into exactly this frame, so showing 16:9 here
   * would be a promise the exported file does not keep.
   */
  const frame = $derived(framePreset(project.frame));
  const frameStyle = $derived(
    `aspect-ratio:${frame.css};max-width:min(100%, calc((100vh - 330px) * ${frame.value}))`
  );

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
      // Raw preview: the user asked to see the recording as it was, cuts and
      // all. Nothing is re-encoded - we simply stop refusing cut ranges.
      const corrected = player.previewRaw ? v.currentTime : project.skipCuts(v.currentTime);
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
      // Raw preview owns the whole source, so it never hands over early.
      if (
        !player.previewRaw &&
        project.clips.length &&
        mainEndSec > 0 &&
        v.currentTime >= mainEndSec - 0.03
      ) {
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
      // Loop: rewind to the start of whatever just finished and keep
      // rolling. The check can lose the race to `ended` (the last
      // timeupdate may never land between mainEnd and duration), so if the
      // element already stopped itself, restart playback explicitly.
      // Image clips tick on an interval, so they stop at the end as before.
      if (player.loop && (!activeClip || activeClip.kind === 'video')) {
        player.seek(
          activeClip
            ? activeClip.inSec
            : (project.orderedSegments.find((s) => s.state === 'keep')?.startSec ?? 0)
        );
        const v = videoEl;
        if (v && (v.paused || v.ended)) {
          void v.play().catch(() => (player.playing = false));
        }
        return;
      }
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

  /**
   * TRUE fullscreen. Element fullscreen used to look fake: the frame style
   * caps the picture with `100vh - 330px` for the normal chrome, so on a
   * fullscreened stage the video stayed small on black. In fullscreen the
   * picture fills the screen (`fsFrameStyle`) and a controls bar fades in —
   * play/pause, seek, time, exit — hiding itself while playback rolls and
   * the mouse is still.
   */
  let fs = $state(false);
  let controlsVisible = $state(true);
  let controlsTimer: ReturnType<typeof setTimeout> | null = null;

  const fsFrameStyle = $derived(
    `aspect-ratio:${frame.css};width:min(100%, calc(100vh * ${frame.value}))`
  );

  function wakeControls() {
    if (!fs) return;
    controlsVisible = true;
    if (controlsTimer) clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => (controlsVisible = false), 2500);
  }

  $effect(() => {
    const onFsChange = () => {
      fs = document.fullscreenElement === stage;
      controlsVisible = true;
      wakeControls();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  });

  function toggleFullscreen() {
    const s = stage;
    if (!s) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void s.requestFullscreen?.();
  }

  const curLine = $derived(activeClip ? undefined : project.lines[project.cursor]);
  const inCut = $derived(!activeClip && project.isCutAt(player.currentTime));

  /**
   * Word cut from the strip under the video.
   *
   * The strip is where the user is already looking, so it is a first-class
   * place to select words — not just a caption. Same flow as a transcript row:
   * drag the words, the confirmation toolbar appears on them, Cut commits. A
   * selection that silently does nothing is the bug this prevents.
   */
  let stripText: HTMLParagraphElement | null = $state(null);
  let stripSel = $state<
    | ({
        lineId: string;
        fromSec: number;
        toSec: number;
        snapped: boolean;
        words: number;
      } & Pick<WordSelection, 'from' | 'to' | 'text' | 'rect'>)
    | null
  >(null);

  const shorten = (s: string) => (s.length > 48 ? `${s.slice(0, 48).trimEnd()}…` : s);

  // Live selection, exactly like the transcript panel: the toolbar is already
  // there on the first dragged word instead of waiting for `mouseup`.
  $effect(() => {
    const stop = watchWordSelection(
      () => stripText,
      (hit) => {
        if (!hit) {
          if (stripSel) stripSel = null;
          wordCutPreview.clear('strip');
          return;
        }
        const plan = project.previewWordCut(hit.lineId, hit.from, hit.to);
        if (!plan) {
          if (stripSel) stripSel = null;
          wordCutPreview.clear('strip');
          return;
        }
        stripSel = {
          lineId: hit.lineId,
          from: hit.from,
          to: hit.to,
          text: hit.text,
          rect: hit.rect,
          fromSec: plan.fromSec,
          toSec: plan.toSec,
          snapped: plan.snapped,
          words: wordCount(hit.text)
        };
        wordCutPreview.set(
          'strip',
          [{ fromSec: plan.fromSec, toSec: plan.toSec }],
          hit.text,
          plan.approx,
          plan.snapped
        );
      }
    );
    return () => {
      stop();
      wordCutPreview.clear('strip');
    };
  });

  function applyStripCut() {
    const picked = stripSel;
    if (!picked) return;
    const res = project.cutWords(picked.lineId, picked.from, picked.to);
    if (!res.ok) {
      toast.push('warn', 'Selection cut nahi ho saka — words dobara select karo.');
      return;
    }
    stripSel = null;
    wordCutPreview.clear();
    window.getSelection()?.removeAllRanges();
    const tail = res.snapped ? ' · audio gap par snap' : '';
    toast.push(
      'cut',
      res.rows > 1
        ? `${res.rows} clips banengi — “${shorten(res.text)}” cut${tail}`
        : `Line cut — “${shorten(res.text)}”${tail}`
    );
  }

  function dismissStripCut() {
    stripSel = null;
    wordCutPreview.clear();
    window.getSelection()?.removeAllRanges();
  }

  // The strip follows the playhead: a pending selection belongs to the line it
  // was drawn on, so moving to another line must not leave a stale toolbar.
  // The timeline band is cleared with it, otherwise it would keep pointing at
  // words the user is no longer looking at.
  $effect(() => {
    const id = curLine?.id;
    untrack(() => {
      if (stripSel && stripSel.lineId !== id) {
        stripSel = null;
        wordCutPreview.clear();
      }
    });
  });

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

  /**
   * Whoever owns the sound right now: the extra clip being previewed, or the
   * main-cut segment under the playhead. Never both - the preview is one video
   * element, and `activeClip` means the main cut is not the thing on screen.
   * Volume lives in one pair of maps keyed by id, so a clip and a segment are
   * read through the same two functions.
   */
  const audioOwner = $derived(activeClip ?? currentSegment);

  const audioHidden = $derived(
    project.isTrackHidden('audio') || (audioOwner ? project.isSegmentMuted(audioOwner.id) : false)
  );
  /** Per-clip loudness (the sketch's "mute/volume too because new clip"). */
  const audioGain = $derived(audioOwner ? project.segmentGain(audioOwner.id) : 1);
  const videoHidden = $derived(project.isTrackHidden('video'));
  const clipTimeLeft = $derived(
    activeClip ? Math.max(0, activeClip.outSec - player.currentTime) : 0
  );

  /** The last kept source second — where the main cut ends (cut blocks excluded). */
  const mainEndSec = $derived.by(() => {
    const kept = project.orderedSegments.filter((s) => s.state === 'keep');
    return kept.length ? Math.max(...kept.map((s) => s.endSec)) : 0;
  });

  $effect(() => {
    const v = videoEl;
    if (!v) return;
    v.muted = audioHidden;
    // The element clamps at 1.0; the model does too, so preview and export
    // can never disagree about how loud a clip is.
    v.volume = audioGain;
  });
</script>

<!-- PREVIEW STAGE - no toolbar; Clipchamp keeps the transport in the timeline row below -->
<div
  bind:this={stage}
  data-focus="stage"
  tabindex="-1"
  role="region"
  aria-label="Video preview"
  onpointermove={wakeControls}
  class="relative isolate flex min-h-0 flex-1 flex-col overflow-hidden bg-nc-bg outline-none
         {fs ? (controlsVisible || !player.playing ? 'cursor-default' : 'cursor-none') : ''}"
>
  {#if project.media}
    <!-- YouTube-style Ambient Mode glow — region 1 of a three-part band (this
         stage, the preview bar, the timeline tool row), all sampling the SAME
         `<video>`, so no second decoder exists anywhere.

         It sits strictly BEHIND the player and fills the whole stage
         (`inset-0`), no frame-shaped box: the mask fades to zero exactly at
         the stage edges, so nothing looks sliced into a rectangle. The stage
         stays `bg-nc-bg` + `isolate`, which keeps `mix-blend-mode: screen`
         inside — the glow can never tint the media or transcript panels, and
         the player itself is never filtered (no blur, no saturation: the
         picture stays crisp; only this backdrop blooms). -->
    <AmbientGlow video={videoEl} {poster} />

    <!-- The picture area. The stage is a column now: this row takes every pixel
         the current-line strip below does not need, so the video stays as large
         as before and the strip never covers the picture. -->
    <div
      class="relative z-10 grid min-h-0 w-full flex-1 place-items-center overflow-hidden
             {fs ? 'p-0' : 'px-4 pt-4'}"
    >
      <!-- The project's own frame, fitted to the stage, in front of the glow -->
      <div
        class="relative z-10 max-h-full w-full overflow-hidden rounded bg-black shadow-lg ring-1 ring-white/5"
        style={fs ? fsFrameStyle : frameStyle}
      >
        {#if isImage && activeClip}
          <!-- A still clip: no decoder, just the picture for its clip length. -->
          <button
            type="button"
            class="relative z-10 block h-full w-full cursor-pointer {videoHidden
              ? 'invisible'
              : ''}"
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
            {#if player.previewRaw}
              <span
                class="w-fit rounded bg-amber-500/80 px-2 py-0.5 text-[10px] font-bold tracking-wider text-nc-bg backdrop-blur-md"
                title="Raw preview — cut material is playing exactly as recorded"
              >
                ◉ RAW · CUT MATERIAL PLAYING
              </span>
            {:else}
              <span
                class="w-fit rounded bg-nc-red/40 px-2 py-0.5 text-[10px] font-bold tracking-wider text-white backdrop-blur-md"
                title="Playhead is inside a cut range - preview skips it"
              >
                ✕ CUT RANGE · SKIPPED
              </span>
            {/if}
          {/if}
          {#if activeClip}
            <span
              class="w-fit rounded bg-nc-brand/85 px-2 py-0.5 text-[10px] font-semibold text-nc-bg"
              title="This clip is on the timeline but has no transcript; it plays as-is"
            >
              ▶ {activeClip.name} · {fmtTime(clipTimeLeft)} left
            </span>
          {/if}
        </div>
      </div>

      <!-- fullscreen — hidden while the fullscreen controls bar owns the exit -->
      {#if !fs}
        <button
          onclick={toggleFullscreen}
          class="absolute right-4 bottom-3 z-20 grid h-8 w-8 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
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
      {/if}
    </div>

    {#if !fs && (activeClip || project.lines.length)}
      <!--
        The line under the playhead, where the eye already is: below the picture,
        full text, with the same controls its transcript row has (pin / keep /
        cut). The old chip floated *over* the video and truncated the words —
        the one place a transcript must never be cut.
      -->
      <div class="relative z-10 w-full shrink-0 px-4 pb-1 pt-2">
        <div
          class="mx-auto flex w-full max-w-[980px] items-start gap-2 rounded-lg border border-nc-line/70 bg-nc-panel/70 px-3 py-2"
        >
          {#if activeClip}
            <span
              class="mt-[2px] shrink-0 rounded bg-nc-brand/15 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-nc-brand"
            >
              CLIP
            </span>
            <p class="min-w-0 flex-1 truncate text-xs leading-5 text-nc-txt">{activeClip.name}</p>
            <span class="shrink-0 self-center text-[10px] text-nc-mut-2">transcript nahi hai</span>
          {:else if curLine}
            <span class="mt-[2px] w-[62px] shrink-0 font-mono text-[9px] leading-4 text-nc-mut-2">
              <span class="block">{fmtShort(curLine.startSec)}</span>
              <span class="block text-nc-mut-2/70">– {fmtShort(curLine.endSec)}</span>
            </span>
            <!-- Full line: wraps, never truncates. An unusually long imported
                 line scrolls inside a capped box instead of eating the video.
                 This is a text-selection surface, not a click control: the
                 selection watcher reads the drag, nothing activates. -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <p
              bind:this={stripText}
              data-line-text
              data-line-id={curLine.id}
              class="nc-scroll max-h-[5.5rem] min-h-4 min-w-0 flex-1 select-text overflow-y-auto text-xs
                     leading-5
                     {curLine.keep === 'cut'
                ? 'text-nc-mut line-through decoration-nc-red/70'
                : 'text-nc-txt'}"
              dir="auto"
              title="Words drag karke cut karo — Enter ya Delete se confirm"
            >
              {curLine.text}
            </p>
            <div class="flex shrink-0 items-center gap-1">
              <button
                onclick={() => project.toggleProtected(curLine.id)}
                aria-pressed={Boolean(curLine.protected)}
                class="grid h-6 w-6 place-items-center rounded border transition-colors
                       {curLine.protected
                  ? 'border-nc-brand bg-nc-brand/15 text-nc-brand'
                  : 'border-nc-line-2 text-nc-mut-2 hover:border-nc-brand hover:text-nc-brand'}"
                title="Pin — auto-cut is line ko kabhi nahi chhuega"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                >
                  <path d="M12 17v5M9 3h6l-1 6 3 3H7l3-3-1-6z" />
                </svg>
              </button>
              <button
                onclick={() => project.setLine(curLine.id, 'keep')}
                class="grid h-6 w-6 place-items-center rounded border transition-colors
                       {curLine.keep === 'keep'
                  ? 'border-nc-green bg-nc-green/15 text-nc-green'
                  : 'border-nc-line-2 text-nc-mut-2 hover:border-nc-green hover:text-nc-green'}"
                title="Keep ✓ (V)"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                >
                  <path d="M4 12l5 5L20 6" />
                </svg>
              </button>
              <button
                onclick={() => project.setLine(curLine.id, 'cut')}
                class="grid h-6 w-6 place-items-center rounded border transition-colors
                       {curLine.keep === 'cut'
                  ? 'border-nc-red bg-nc-red/15 text-nc-red'
                  : 'border-nc-line-2 text-nc-mut-2 hover:border-nc-red hover:text-nc-red'}"
                title="Cut ✕ (X)"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                >
                  <path d="M5 5l14 14M19 5L5 19" />
                </svg>
              </button>
            </div>
          {:else}
            <p class="w-full py-0.5 text-center text-[11px] text-nc-mut-2">
              Is waqt koi transcript line nahi.
            </p>
          {/if}
        </div>

        {#if !stripSel}
          <p
            class="mx-auto mt-1 flex w-full max-w-[980px] items-center justify-end gap-1 text-[9px]
                   text-nc-mut-2"
          >
            <svg
              width="9"
              height="9"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              aria-hidden="true"
            >
              <circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" />
              <path d="M8 7.6L20 19M8 16.4L20 5" />
            </svg>
            Tip: is line me words select karo → Cut
          </p>
        {/if}
      </div>
    {/if}

    {#if stripSel}
      <WordCutToolbar
        text={stripSel.text}
        fromSec={stripSel.fromSec}
        toSec={stripSel.toSec}
        snapped={stripSel.snapped}
        words={stripSel.words}
        rect={stripSel.rect}
        oncancel={dismissStripCut}
        oncut={applyStripCut}
      />
    {/if}

    {#if fs}
      <!-- FULLSCREEN CONTROLS — play/pause, seek, time, exit. Fades out while
           the video rolls and the mouse is still; Esc always exits. -->
      <div
        class="absolute inset-x-0 bottom-0 z-30 flex items-center gap-3 px-5 pb-4 pt-12 transition-opacity duration-300
               {controlsVisible || !player.playing
          ? 'opacity-100'
          : 'pointer-events-none opacity-0'}"
        style="background:linear-gradient(to top, rgba(0,0,0,.78), transparent)"
      >
        <button
          onclick={() => player.toggle()}
          class="grid h-9 w-9 place-items-center rounded-md text-white transition-colors hover:bg-white/10"
          title="Play / pause (Space)"
        >
          {#if player.playing}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" /><rect
                x="14"
                y="5"
                width="4"
                height="14"
                rx="1"
              />
            </svg>
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5l11 7-11 7z" />
            </svg>
          {/if}
        </button>
        <span class="font-mono text-[11px] text-white/90">{fmtTime(player.currentTime)}</span>
        <input
          type="range"
          min="0"
          max={mainEndSec || 1}
          step="0.01"
          value={player.currentTime}
          oninput={(e) => player.seek(+e.currentTarget.value)}
          class="h-1 min-w-0 flex-1 cursor-pointer accent-[#4D8DFF]"
          aria-label="Seek"
        />
        <span class="font-mono text-[11px] text-white/90">{fmtTime(mainEndSec)}</span>
        <button
          onclick={toggleFullscreen}
          class="grid h-9 w-9 place-items-center rounded-md text-white transition-colors hover:bg-white/10"
          title="Exit fullscreen (Esc)"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <path d="M8 3v5H3M16 21v-5h5M3 16h5v5M21 8h-5V3" />
          </svg>
        </button>
      </div>
    {/if}
  {:else}
    <div class="grid flex-1 place-items-center p-4">
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
            Koi video nahi khuli. Left ke <b class="text-nc-brand">My media</b> panel me
            <b class="text-nc-brand">Import media</b> dabao, ya Dashboard se naya project banao.
          </p>
        {/if}
      </div>
    </div>
  {/if}
</div>
