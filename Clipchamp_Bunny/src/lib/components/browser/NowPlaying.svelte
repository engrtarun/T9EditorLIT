<script lang="ts">
  /**
   * The now-playing bar — Edge's media hub, inside T9.
   *
   * Windows' own flyout (`smtc.rs`) cannot show `02:22 / 18:11`, and its seek
   * bar is not draggable on every build, so the controllable timeline lives
   * here: a thin strip between the address bar and the page. It sits
   * **outside** `[data-focus="browser-content"]` on purpose — the child
   * webview is positioned over that rect only, so the bar takes layout space
   * and the page starts below it instead of painting over it.
   *
   * The bar is a view of the same report the flyout paints: Rust emits
   * `browser:media` for the owning tab, and every button or drag goes back
   * through `browser_media_action`, the exact path the flyout and the earbud
   * already use. The position between heartbeats is interpolated locally, so
   * the clock moves smoothly without an IPC call every frame.
   */
  import { onMount } from 'svelte';
  import BrandMark from '../dashboard/BrandMark.svelte';
  import { browser } from '../../stores/browser.svelte';
  import {
    browserMediaAction,
    browserMediaState,
    onBrowserMedia,
    type BrowserMediaSnapshot
  } from '../../ipc';

  /** Fullscreen hides the bar but keeps its box: a layout change there would
   *  feed a new rect back to Rust while its grown webview covers the window. */
  let { hidden = false }: { hidden?: boolean } = $props();

  let snap = $state<BrowserMediaSnapshot | null>(null);
  /** Drawn position, seconds. Interpolated between reports while playing. */
  let position = $state(0);
  /** The user is holding the slider: reports must not yank the thumb back. */
  let dragging = $state(false);
  /** Last artwork URL the browser failed to load (CSP, expired CDN link). */
  let artFailed = $state('');

  let basePos = 0;
  let baseAt = 0;

  const visible = $derived(snap !== null && snap.state !== 'none');
  const playing = $derived(snap?.state === 'playing');
  const duration = $derived(
    snap && Number.isFinite(snap.duration) ? Math.max(0, snap.duration) : 0
  );
  const percent = $derived(
    duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0
  );

  function clock(seconds: number): string {
    const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function apply(next: BrowserMediaSnapshot | null): void {
    if (!next || next.state === 'none') {
      snap = null;
      return;
    }
    snap = next;
    basePos = Number.isFinite(next.position) ? next.position : 0;
    baseAt = Date.now();
    if (!dragging) position = basePos;
  }

  onMount(() => {
    let dead = false;
    let off: (() => void) | null = null;

    void onBrowserMedia(apply)
      .then((unlisten) => {
        if (dead) unlisten();
        else off = unlisten;
      })
      .catch(() => {
        /* dev preview: no native event bus */
      });

    // A paused video sends no heartbeats; without this, leaving the browser
    // and coming back would show no bar until the page reports again.
    void browserMediaState().then((initial) => {
      if (!dead && initial) apply(initial);
    });

    // Reports arrive every ~1.6 s; the clock and thumb need to move in
    // between. 4 Hz is enough to look continuous and cheap enough to leave
    // the page's own rendering alone.
    const tick = setInterval(() => {
      if (!snap || snap.state !== 'playing' || dragging) return;
      const rate = snap.rate > 0 && Number.isFinite(snap.rate) ? snap.rate : 1;
      const next = basePos + ((Date.now() - baseAt) / 1000) * rate;
      position = duration > 0 ? Math.min(next, duration) : next;
    }, 250);

    return () => {
      dead = true;
      off?.();
      clearInterval(tick);
    };
  });

  function toggle(): void {
    if (!snap) return;
    void browserMediaAction(snap.state === 'playing' ? 'pause' : 'play');
  }

  function step(action: 'prev' | 'next'): void {
    void browserMediaAction(action);
  }

  function beginSeek(event: Event): void {
    dragging = true;
    position = Number((event.currentTarget as HTMLInputElement).value);
  }

  function commitSeek(event: Event): void {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    dragging = false;
    basePos = value;
    baseAt = Date.now();
    position = value;
    void browserMediaAction('seek', value);
  }

  /** Bring the page that owns the session back on screen. */
  function focusTab(): void {
    if (!snap || browser.activeId === snap.tab) return;
    if (browser.tabs.some((tab) => tab.id === snap?.tab)) browser.select(snap.tab);
  }
</script>

<div class="shrink-0" class:invisible={hidden}>
  {#if visible && snap}
    <div
      class="flex h-11 items-center gap-2.5 border-b border-nc-line bg-nc-panel px-2.5"
      role="region"
      aria-label="Now playing"
    >
      <!-- Artwork + title: one button, because clicking either should feel
           like going to the video that is playing. -->
      <button
        type="button"
        onclick={focusTab}
        class="flex min-w-0 max-w-[300px] shrink items-center gap-2 rounded-md py-0.5 pr-1 text-left transition-colors hover:bg-nc-panel-2"
        title="Go to the playing tab"
      >
        <span
          class="grid h-[30px] w-[30px] shrink-0 place-items-center overflow-hidden rounded bg-nc-panel-2"
        >
          {#if snap.artwork && artFailed !== snap.artwork}
            <img
              src={snap.artwork}
              alt=""
              class="h-full w-full object-cover"
              onerror={() => (artFailed = snap?.artwork ?? '')}
            />
          {:else}
            <BrandMark size={17} />
          {/if}
        </span>
        <span class="min-w-0">
          <span class="block truncate text-[11.5px] leading-tight font-semibold text-nc-txt">
            {snap.title || 'Media'}
          </span>
          <span class="block truncate text-[10px] leading-tight text-nc-mut">
            {snap.artist || snap.album}
          </span>
        </span>
      </button>

      <!-- 02:22 ─────────●──────── 18:11 -->
      <div class="flex min-w-[140px] flex-1 items-center gap-2">
        <span class="w-9 shrink-0 text-right text-[10px] tabular-nums text-nc-mut">
          {clock(position)}
        </span>
        <input
          type="range"
          class="t9-seek min-w-[70px] flex-1"
          min="0"
          max={duration || 0}
          step="0.1"
          value={position}
          disabled={duration <= 0}
          style="--t9-pct: {percent}%"
          aria-label="Seek"
          aria-valuetext="{clock(position)} of {clock(duration)}"
          oninput={beginSeek}
          onchange={commitSeek}
        />
        <span class="w-9 shrink-0 text-[10px] tabular-nums text-nc-mut">
          {duration > 0 ? clock(duration) : '--:--'}
        </span>
      </div>

      <div class="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onclick={() => step('prev')}
          disabled={!snap.prev}
          class="grid h-7 w-7 place-items-center rounded-full text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-30 disabled:hover:bg-transparent"
          title="Previous"
          aria-label="Previous track"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M6 5v14M19 5l-9 7 9 7" />
          </svg>
        </button>

        <button
          type="button"
          onclick={toggle}
          class="grid h-8 w-8 place-items-center rounded-full bg-nc-panel-2 text-nc-txt transition-colors hover:bg-nc-line"
          title={playing ? 'Pause' : 'Play'}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {#if playing}
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
            >
              <path d="M9 5v14M15 5v14" />
            </svg>
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5.2l11 6.8-11 6.8z" />
            </svg>
          {/if}
        </button>

        <button
          type="button"
          onclick={() => step('next')}
          disabled={!snap.next}
          class="grid h-7 w-7 place-items-center rounded-full text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-30 disabled:hover:bg-transparent"
          title="Next"
          aria-label="Next track"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 5v14M5 5l9 7-9 7" />
          </svg>
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  /* A native range with `accent-color` is Chromium's default look: a thick
     grey track and a fat thumb. This is the thin Edge-style line, with the
     played part in brand blue and a compact white thumb. */
  .t9-seek {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    border-radius: 999px;
    background: linear-gradient(
      to right,
      var(--color-nc-brand) 0,
      var(--color-nc-brand) var(--t9-pct, 0%),
      var(--color-nc-line-2) var(--t9-pct, 0%),
      var(--color-nc-line-2) 100%
    );
    outline: none;
    cursor: pointer;
  }

  .t9-seek:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .t9-seek::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 11px;
    height: 11px;
    border-radius: 999px;
    background: #fff;
    border: 2px solid var(--color-nc-brand);
    box-shadow: 0 1px 3px rgb(0 0 0 / 45%);
    transition: transform 120ms ease;
  }

  .t9-seek:hover::-webkit-slider-thumb,
  .t9-seek:focus-visible::-webkit-slider-thumb {
    transform: scale(1.15);
  }

  .t9-seek:focus-visible {
    outline: 2px solid var(--color-nc-brand);
    outline-offset: 4px;
  }
</style>
