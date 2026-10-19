<script lang="ts">
  import { player } from '../../stores/player.svelte';
  import { project } from '../../stores/project.svelte';
  import { fmtTime } from '../../utils';

  let videoEl: HTMLVideoElement | null = $state(null);
  let scrubbing = false;

  const onLoaded = () => {
    const v = videoEl;
    if (!v) return;
    player.attach(v);
    if (project.media) {
      project.media.durationSec = isFinite(v.duration) ? v.duration : project.durationSec;
      project.media.width = v.videoWidth;
      project.media.height = v.videoHeight;
    }
  };

  /**
   * Phantom Cut — the whole point of this app.
   * Playing never re-encodes; we just refuse to sit inside a ✕ range.
   */
  function onTimeUpdate() {
    const v = videoEl;
    if (!v || scrubbing) return;
    const corrected = project.skipCuts(v.currentTime);
    if (corrected !== v.currentTime) {
      scrubbing = true;
      v.currentTime = corrected;
      scrubbing = false;
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

  const curLine = $derived(project.lines[project.cursor]);
  const inCut = $derived(project.isCutAt(player.currentTime));
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <!-- preview toolbar -->
  <div class="flex h-11 shrink-0 items-center gap-2 border-b border-nc-line px-3">
    <button
      onclick={() => player.toggle()}
      class="grid h-8 w-8 place-items-center rounded-lg border border-nc-line-2 bg-nc-panel-2 hover:bg-nc-line"
      title="Play / Pause (Space)"
    >
      {#if player.playing}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
        </svg>
      {:else}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
          ><path d="M8 5v14l11-7z" /></svg
        >
      {/if}
    </button>

    <span class="font-mono text-xs text-nc-mut">
      <span class="text-nc-gold">{fmtTime(player.currentTime)}</span>
      <span class="text-nc-mut-2"> / {fmtTime(project.durationSec)}</span>
    </span>

    {#if inCut}
      <span
        class="rounded bg-nc-red/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-nc-red"
        title="Playhead is inside a cut range — preview skips it"
      >
        ✕ CUT RANGE · SKIPPED
      </span>
    {/if}

    <div class="flex-1"></div>

    {#if curLine}
      <span
        class="max-w-[52%] truncate rounded px-2 py-1 text-[11px]
               {curLine.keep === 'keep'
          ? 'bg-nc-green/10 text-nc-green'
          : 'bg-nc-red/10 text-nc-red'}"
        title="Line under the playhead"
      >
        {curLine.keep === 'keep' ? '✓' : '✕'}
        {curLine.text}
      </span>
    {/if}
  </div>

  <!-- 16:9 stage -->
  <div class="grid min-h-0 flex-1 place-items-center bg-nc-bg p-4">
    {#if project.media}
      <div class="relative max-h-full max-w-full overflow-hidden rounded bg-black shadow-2xl">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={videoEl}
          src={project.media.url}
          class="block max-h-[calc(100vh-420px)] w-auto max-w-full"
          onloadedmetadata={onLoaded}
          ontimeupdate={onTimeUpdate}
          onplay={onPlay}
          onpause={onPause}
          onclick={() => player.toggle()}
        ></video>

        {#if curLine?.keep === 'cut'}
          <div
            class="pointer-events-none absolute inset-0 border-2 border-nc-red/70"
            style="background:repeating-linear-gradient(45deg,transparent,transparent 10px,rgba(229,72,77,.14) 10px,rgba(229,72,77,.14) 20px)"
          ></div>
        {/if}
      </div>
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
            class="text-nc-gold"
          >
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
          </svg>
        </div>
        <p class="text-sm font-semibold">Overtime nahi karna hai.</p>
        <p class="mt-2 text-xs leading-relaxed text-nc-mut">
          Prototype me mock transcript chal raha hai. Apni video load karne ke liye
          <b class="text-nc-gold">Mode 1 · Ingest</b> pe jao.
        </p>
      </div>
    {/if}
  </div>
</div>
