<script lang="ts">
  /**
   * Stage — the centre surface: undo/redo, the floating Size toolbar, the
   * black 16:9 canvas, Share/Export.
   *
   * The <video> streams from disk through the Tauri asset protocol, so a 5 GB
   * source is never buffered into RAM; ✕ segments are skipped on `timeupdate`
   * — the Phantom Cut.
   *
   * Full-screen preview (bottom-right corner button, or `F`) does NOT mount a
   * second <video>. The existing canvas wrapper is repositioned over the whole
   * window with `fixed inset-0`, which means one element, one decoder and no
   * playback position to re-sync — the same reason Clipchamp's own preview
   * expands in place instead of opening a new surface. It also stays inside
   * the app, which is safer than `requestFullscreen()` inside a WebView, where
   * a refused request can leave the window stuck.
   *
   * Keys are registered with the `shortcuts` store, never via a local window
   * listener, so this component cannot fight Timeline or the cheat sheet for
   * Space / arrows.
   */
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { project } from "../../stores/project.svelte";
  import { transcript } from "../../stores/transcript.svelte";
  import { player } from "../../stores/player.svelte";
  import { shortcuts } from "../../stores/shortcuts.svelte";
  import { mode } from "../../stores/mode.svelte";
  import { formatClock } from "../../timeline-utils";

  let { busy = false }: { busy?: boolean } = $props();

  const videoSrc = $derived(
    project.hasMedia && project.info ? convertFileSrc(project.info.path) : null,
  );

  let skipPending = $state(false);

  // ── Full-screen preview, captions, audio ───────────────────────────────
  let fullscreen = $state(false);
  let captionsOn = $state(true);
  /** Mirrors of the element, kept for the toolbar's pressed/coloured state. */
  let muted = $state(false);
  let volume = $state(1);

  /** Live position, shared by the in-canvas bar and the overlay. */
  let currentSecs = $state(0);

  /** Targets for the two "go to" keys that belong to this screen. */
  let sizeBtn: HTMLButtonElement | null = $state(null);
  let stageEl: HTMLElement | null = $state(null);

  const captionText = $derived.by(() => {
    if (!captionsOn) return null;
    const line = transcript.lines.find(
      (l) => currentSecs >= l.startSecs && currentSecs < l.endSecs,
    );
    return line ? line.text : null;
  });

  // Keep the local volume/mute mirrors in step with the element.
  $effect(() => {
    const el = player.element;
    if (!el) return;
    const sync = () => {
      volume = el.volume;
      muted = el.muted;
    };
    sync();
    el.addEventListener("volumechange", sync);
    return () => el.removeEventListener("volumechange", sync);
  });

  function handleExport() {
    if (!project.hasMedia) return;
    mode.set("export");
  }

  function findCutSegment(t: number) {
    return transcript.lines.find((l) => !l.keep && t >= l.startSecs && t < l.endSecs);
  }

  function findNextKept(start: number) {
    return transcript.lines.find((l) => l.keep && l.startSecs >= start);
  }

  function handleTimeUpdate(e: Event) {
    const video = e.currentTarget as HTMLVideoElement;
    currentSecs = video.currentTime;
    if (skipPending) return;
    const cut = findCutSegment(video.currentTime);
    if (!cut) return;
    const next = findNextKept(cut.endSecs);
    if (next) {
      skipPending = true;
      video.currentTime = next.startSecs;
    }
  }

  function handleSeeked() {
    skipPending = false;
  }

  /** The overlay's scrubber — 0…1 straight to the element. */
  function scrubTo(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    player.seek(Number(input.value) * player.duration);
  }

  // ── Shortcuts ──────────────────────────────────────────────────────────
  // Registered per-mount: the effect's cleanup unregisters, so a stage that
  // unmounts (mode isolation, Home screen) takes its bindings with it.
  $effect(() => {
    const un = [
      shortcuts.bind("playPause", () => player.togglePlay()),
      shortcuts.bind("undo", () => void transcript.undo()),
      shortcuts.bind("redo", () => void transcript.redo()),
      shortcuts.bind("redoShift", () => void transcript.redo()),
      shortcuts.bind("seekStart", () => player.seek(0)),
      shortcuts.bind("seekEnd", () => player.toEnd()),
      shortcuts.bind("seekBack", () => player.scrub(-5)),
      shortcuts.bind("seekForward", () => player.scrub(5)),
      shortcuts.bind("seekBackBig", () => player.scrub(-10)),
      shortcuts.bind("seekForwardBig", () => player.scrub(10)),
      shortcuts.bind("volumeUp", () => player.nudgeVolume(0.05)),
      shortcuts.bind("volumeDown", () => player.nudgeVolume(-0.05)),
      shortcuts.bind("mute", () => player.toggleMute()),
      shortcuts.bind("captions", () => (captionsOn = !captionsOn)),
      shortcuts.bind("fullscreen", () => (fullscreen = !fullscreen)),
      shortcuts.bind("export", () => handleExport()),
      // "Go to" keys: focus moves, like Clipchamp's own Alt+1…5 family.
      shortcuts.bind("aspectRatio", () => sizeBtn?.focus()),
      shortcuts.bind("navStage", () => stageEl?.focus()),
    ];
    return () => un.forEach((fn) => fn());
  });

  // Escape is Clipchamp's "deselect"; here it also means "leave full screen".
  $effect(() => {
    return shortcuts.bind(
      "deselect",
      () => {
        if (fullscreen) fullscreen = false;
      },
      "always",
    );
  });

  /** Seconds → the `0:00 / 0:36` pair Clipchamp shows under the preview. */
  const timeLabel = $derived(
    project.hasMedia ? `${formatClock(currentSecs)} / ${project.durationLabel}` : "0:00 / 0:00",
  );

  /** Clipchamp's transport bar: seek-to-start, −5, play, +5, seek-to-end. */
  const TRANSPORT = [
    { id: "toStart", title: "Seek to start", action: () => player.seek(0) },
    { id: "fastBackward", title: "Seek back 5 seconds", action: () => player.scrub(-5) },
    { id: "playPause", title: "Play or pause SPACE", action: () => player.togglePlay() },
    { id: "fastForward", title: "Seek forward 5 seconds", action: () => player.scrub(5) },
    { id: "toEnd", title: "Seek to end", action: () => player.toEnd() },
  ] as const;
</script>

<section bind:this={stageEl} class="flex min-h-0 flex-1 flex-col" aria-label="Stage" tabindex="-1">
  <!-- Toolbar row -->
  <div class="flex h-12 shrink-0 items-center gap-2 px-3">
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-md text-cc-text-4 hover:bg-cc-tint
        disabled:cursor-not-allowed"
      title="Undo Ctrl + Z"
      disabled={!transcript.hasTranscript}
      onclick={() => void transcript.undo()}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M8 7 4 11l4 4" />
        <path d="M4 11h9a6 6 0 0 1 0 12h-2" />
      </svg>
    </button>
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-md text-cc-text-4 hover:bg-cc-tint
        disabled:cursor-not-allowed"
      title="Redo Ctrl + Y"
      disabled={!transcript.hasTranscript}
      onclick={() => void transcript.redo()}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m16 7 4 4-4 4" />
        <path d="M20 11h-9a6 6 0 0 0 0 12h2" />
      </svg>
    </button>

    <!-- Floating pill toolbar, centred over the canvas. -->
    <div
      class="mx-auto flex items-center gap-1 rounded-lg border border-cc-line bg-cc-surface px-1.5
        py-1 shadow-sm"
    >
      <button
        type="button"
        bind:this={sizeBtn}
        class="flex items-center gap-1.5 rounded px-2.5 py-1 text-[12.5px] font-semibold
          text-cc-text hover:bg-cc-tint"
        title="Change aspect ratio Alt + R"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          aria-hidden="true"
        >
          <path d="M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3" stroke-linecap="round" />
        </svg>
        Size ⌄
      </button>
      <span class="h-5 w-px bg-cc-line"></span>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded hover:bg-cc-tint"
        title="Background color"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 4h10l3 6-8 10-8-10z" fill="var(--color-cc-purple)" />
        </svg>
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded hover:bg-cc-tint
          {captionsOn ? 'text-cc-link' : 'text-cc-text-3'}"
        title="Show captions C"
        aria-pressed={captionsOn}
        onclick={() => (captionsOn = !captionsOn)}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="18" height="14" rx="2.5" />
          <path d="M8.5 10.5a2 2 0 1 0 0 3M16.5 10.5a2 2 0 1 0 0 3" stroke-linecap="round" />
        </svg>
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded hover:bg-cc-tint
          {muted ? 'text-cc-cut' : 'text-cc-text-3'}"
        title="Mute M"
        aria-pressed={muted}
        onclick={() => player.toggleMute()}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M4 9v6h3.5L12 19V5L7.5 9H4z" />
          {#if muted}
            <path d="m16 9.5 4 5M20 9.5l-4 5" />
          {:else}
            <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 7a7.4 7.4 0 0 1 0 10" />
          {/if}
        </svg>
      </button>
      <!-- Live readout, so the volume keys have visible feedback. -->
      {#if !muted && volume < 1}
        <span class="mono w-8 text-center text-[10px] text-cc-text-4">
          {Math.round(volume * 100)}
        </span>
      {/if}
    </div>

    <div class="flex items-center gap-2">
      <button type="button" class="cc-btn" title="Share">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="6" cy="12" r="2.5" />
          <circle cx="17" cy="6" r="2.5" />
          <circle cx="17" cy="18" r="2.5" />
          <path d="m8.3 10.8 6.4-3.6M8.3 13.2l6.4 3.6" />
        </svg>
        Share
      </button>
      <button
        type="button"
        class="cc-btn cc-btn-primary"
        disabled={!project.hasMedia || busy}
        title={project.hasMedia ? "Open Export panel Alt + E" : "Import media first"}
        onclick={handleExport}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M12 19V5m0 0-5 5m5-5 5 5" />
        </svg>
        Export
      </button>
    </div>
  </div>

  <!-- Canvas. `fixed inset-0` swaps this very element into full screen. -->
  <div class="flex min-h-0 flex-1 items-center justify-center px-6 pb-2">
    <div
      class="relative flex items-center justify-center overflow-hidden bg-black
        {fullscreen
        ? 'fixed inset-0 z-[98] pb-16'
        : 'aspect-video max-h-full w-full max-w-[900px] rounded-sm'}"
    >
      {#if project.loading}
        <!-- Opened from Home: the shell paints immediately and says what the
             background probe is doing, rather than freezing on Home until
             ffprobe answers. -->
        <div class="flex flex-col items-center gap-2 p-6 text-center">
          <h2 class="text-[15px] font-semibold text-white/90">Reading video info…</h2>
          <p class="max-w-sm text-[12.5px] leading-relaxed text-white/55">
            ffprobe is walking the file in the background — the editor is already usable, and
            nothing is buffered into memory.
          </p>
        </div>
      {:else if !project.hasMedia}
        <div class="flex flex-col items-center gap-2 p-6 text-center">
          <h2 class="text-[15px] font-semibold text-white/90">Load a source video to begin</h2>
          <p class="max-w-sm text-[12.5px] leading-relaxed text-white/55">
            Drop a recording up to 5&nbsp;GB anywhere on this window, or pick one from
            <strong>My media</strong> — it is probed with ffprobe, never loaded into memory.
          </p>
        </div>
      {:else if videoSrc}
        <video
          src={videoSrc}
          class="max-h-full max-w-full object-contain"
          preload="metadata"
          bind:this={player.element}
          ontimeupdate={handleTimeUpdate}
          onseeked={handleSeeked}
        >
          <track kind="captions" />
        </video>

        {#if captionText}
          <!-- Transcript-driven captions: no sidecar file, no extra decode. -->
          <div
            class="pointer-events-none absolute inset-x-6 bottom-3 flex justify-center"
            role="status"
            aria-live="polite"
          >
            <span
              class="rounded bg-black/75 px-3 py-1.5 text-center text-[13px] leading-snug text-white"
            >
              {captionText}
            </span>
          </div>
        {/if}

        {#if fullscreen}
          <!-- Transport bar: toStart, −5, play, +5, toEnd, slider, time, captions, exit. -->
          <div
            class="absolute inset-x-0 bottom-0 flex items-center gap-3 border-t border-white/10
              bg-black px-5 py-3"
          >
            {#each TRANSPORT as button (button.id)}
              <button
                type="button"
                class="flex h-9 w-9 items-center justify-center rounded-full text-white/85
                  transition hover:bg-white/15 hover:text-white"
                data-testid={button.id}
                title={button.title}
                aria-label={button.title}
                onclick={button.action}
              >
                {#if button.id === "toStart"}
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M6 5h2v14H6zM19 5v14l-10-7z" />
                  </svg>
                {:else if button.id === "fastBackward"}
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.9"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M11 6 5 12l6 6" />
                    <path d="M19 6l-6 6 6 6" />
                  </svg>
                {:else if button.id === "playPause"}
                  {#if player.playing}
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                    </svg>
                  {:else}
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path d="M7 4.5v15l13-7.5z" />
                    </svg>
                  {/if}
                {:else if button.id === "fastForward"}
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.9"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m13 6 6 6-6 6" />
                    <path d="m5 6 6 6-6 6" />
                  </svg>
                {:else}
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M17 5h2v14h-2zM5 5v14l10-7z" />
                  </svg>
                {/if}
              </button>
            {/each}

            <!-- Scrubber. A native range keeps the drag maths out of here. -->
            <input
              type="range"
              class="mx-2 h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full
                bg-white/25 accent-white"
              min="0"
              max="1"
              step="0.001"
              value={player.duration > 0 ? currentSecs / player.duration : 0}
              aria-label="Seek"
              oninput={scrubTo}
            />

            <span class="mono shrink-0 text-[12px] text-white/70">{timeLabel}</span>

            <button
              type="button"
              class="flex h-9 w-9 items-center justify-center rounded-full transition
                {captionsOn
                ? 'bg-white/20 text-white'
                : 'text-white/70 hover:bg-white/15 hover:text-white'}"
              title="Show captions C"
              aria-label="Show captions"
              aria-pressed={captionsOn}
              onclick={() => (captionsOn = !captionsOn)}
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                aria-hidden="true"
              >
                <rect x="3" y="5" width="18" height="14" rx="2.5" />
                <path d="M8.5 10.5a2 2 0 1 0 0 3M16.5 10.5a2 2 0 1 0 0 3" stroke-linecap="round" />
              </svg>
            </button>

            <button
              type="button"
              class="flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition
                hover:bg-white/15 hover:text-white"
              title="Exit full screen ESC"
              aria-label="Exit full screen"
              onclick={() => (fullscreen = false)}
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
              </svg>
            </button>
          </div>
        {:else}
          <!-- Full-screen entry, bottom-right corner — where Clipchamp puts it. -->
          <button
            type="button"
            class="absolute right-3 bottom-3 flex h-8 w-8 items-center justify-center rounded-md
              bg-black/55 text-white/85 transition hover:bg-black/80 hover:text-white"
            title="Full screen preview F"
            aria-label="Full screen preview"
            onclick={() => (fullscreen = true)}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.9"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            </svg>
          </button>
        {/if}
      {/if}
    </div>
  </div>
</section>
