<script lang="ts">
  /**
   * The media OSD flyout — `02:22 ─── 18:11`, the timeline Windows cannot show.
   *
   * Windows' own media card (Win + A / Win + N) renders neither time labels
   * nor a draggable seek bar — its SMTC timeline is a hint the panel chooses
   * to draw, and this machine's panel draws none. So the controllable
   * timeline lives in this second, tiny window by the taskbar corner, shown
   * and hidden by Rust (`media_flyout.rs`): it appears on play / pause /
   * media key / seek, and leaves after five quiet seconds unless the pointer
   * rests on it.
   *
   * Everything here is a view of the same report the SMTC session paints:
   * Rust emits `browser:media` for the owning tab, and every button or drag
   * goes back through `browser_media_action` — the exact path the Win + N
   * card and the earbud already use. The position between heartbeats is
   * interpolated locally (4 Hz), so the clock moves without an IPC call per
   * frame.
   *
   * This page is its own webview: it shares no store with the main window,
   * which is why there is no "go to the playing tab" button here — the tab
   * state lives in the other window's JS context.
   *
   * The window behaves like Firefox's picture-in-picture card: drag it by
   * any chrome that is not a button (`data-tauri-drag-region="deep"` — the
   * injected script blocks clicks on buttons/inputs on its own), resize it
   * from the native borders, X to dismiss through `media_flyout_close`.
   * Rust remembers the rect across the idle destroy and the app restart.
   */
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import BrandMark from '../dashboard/BrandMark.svelte';
  import {
    browserMediaAction,
    browserMediaState,
    isTauri,
    mediaFlyoutClose,
    mediaFlyoutPin,
    mediaFlyoutPinned,
    onBrowserMedia,
    type BrowserMediaSnapshot
  } from '../../ipc';

  let snap = $state<BrowserMediaSnapshot | null>(null);
  /** Drawn position, seconds. Interpolated between reports while playing. */
  let position = $state(0);
  /** The user is holding the slider: reports must not yank the thumb back. */
  let dragging = $state(false);
  /** Last artwork URL the browser failed to load (CSP, expired CDN link). */
  let artFailed = $state('');
  /** Pinned: the card stays on screen instead of hiding after 5 s. */
  let pinned = $state(false);
  /** The > chevron expands the "which tab is making noise" detail. */
  let expanded = $state(false);

  let basePos = 0;
  let baseAt = 0;

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

    if (!isTauri()) {
      // localhost preview (`/flyout.html` in the shared dev browser): there
      // is no native event bus, so paint a stand-in card — this is the only
      // way to check the layout before the window exists on a desktop.
      apply({
        tab: 'dev',
        state: 'playing',
        title: 'Dev preview — media flyout',
        artist: 'flyout.html',
        album: '',
        artwork: '',
        position: 142,
        duration: 1091,
        rate: 1,
        next: true,
        prev: true
      });
    } else {
      void onBrowserMedia(apply)
        .then((unlisten) => {
          if (dead) unlisten();
          else off = unlisten;
        })
        .catch(() => {
          /* no native event bus */
        });

      // A paused video sends no heartbeats; without this, the card would
      // open empty until the page reports again.
      void browserMediaState().then((initial) => {
        if (!dead && initial) apply(initial);
      });
      void mediaFlyoutPinned().then((v) => {
        if (!dead) pinned = v;
      });
    }

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

  function send(
    action: 'play' | 'pause' | 'stop' | 'next' | 'prev' | 'seek',
    value?: number
  ): void {
    void browserMediaAction(action, value);
  }

  function togglePin(): void {
    void mediaFlyoutPin(!pinned).then((v) => (pinned = v));
  }

  function toggle(): void {
    if (!snap) return;
    send(snap.state === 'playing' ? 'pause' : 'play');
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
    send('seek', value);
  }
</script>

{#if snap}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="flex h-full flex-col justify-center gap-2 px-3"
    role="region"
    aria-label="Media controls"
    data-tauri-drag-region="deep"
    onmousedown={(e) => {
      // The injected drag script maximizes on a double-click; a 372×104
      // media card must not. Stop the second mousedown before document
      // sees it — single clicks pass through and drag as usual.
      if (e.detail === 2) e.stopPropagation();
    }}
  >
    <!-- Row 1: artwork, title/channel, transport. The card is only a
         window wide, so the title truncates and the buttons never move. -->
    <div class="flex items-center gap-2.5">
      <span
        class="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md bg-nc-panel-2"
      >
        {#if snap.artwork && artFailed !== snap.artwork}
          <img
            src={snap.artwork}
            alt=""
            class="h-full w-full object-cover"
            onerror={() => (artFailed = snap?.artwork ?? '')}
          />
        {:else}
          <BrandMark size={20} />
        {/if}
      </span>

      <span class="min-w-0 flex-1">
        <span class="block truncate text-[11.5px] leading-tight font-semibold text-nc-txt">
          {snap.title || 'Media'}
        </span>
        <span class="block truncate text-[10px] leading-tight text-nc-mut">
          {snap.artist || snap.album}
        </span>
      </span>

      <div class="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onclick={() => send('prev')}
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
          onclick={() => send('next')}
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

        <span class="mx-1 h-4 w-px shrink-0 bg-nc-line" aria-hidden="true"></span>

        <!-- Pin — X ke LEFT. Pinned state is remembered across the idle
             destroy and an app restart, so the card never hides after 5 s. -->
        <button
          type="button"
          onclick={togglePin}
          class="grid h-7 w-7 place-items-center rounded-full transition-colors {pinned
            ? 'bg-nc-brand/15 text-nc-brand'
            : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
          title={pinned ? 'Unpin — 5 s baad card chala jayega' : 'Pin — card ko screen par rakho'}
          aria-label={pinned ? 'Unpin media card' : 'Pin media card'}
          aria-pressed={pinned}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            {#if pinned}
              <path d="M12 17v5" />
              <path d="M9 12l-3 3v2h12v-2l-3-3-1-7h-4l-1 7z" />
            {:else}
              <path d="M12 17v5" />
              <path d="M9 12l-3 3v2h12v-2l-3-3-1-7h-4l-1 7z" opacity="0.55" />
            {/if}
          </svg>
        </button>

        <!-- X — dismiss the card now (Rust hides + destroys the window);
             the next transport transition brings it back. -->
        <button
          type="button"
          onclick={() => void mediaFlyoutClose()}
          class="grid h-7 w-7 place-items-center rounded-full text-nc-mut transition-colors hover:bg-[#c42b1c] hover:text-white"
          title="Close"
          aria-label="Close media card"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <!-- > — X ke right. Multi-tab me audio chal raha ho to notification
             khud hide ho jati hai; ye chevron card ko expand karke tab details
             aur "keep open" dikhata hai. -->
        <button
          type="button"
          onclick={() => (expanded = !expanded)}
          class="grid h-7 w-7 place-items-center rounded-full text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt"
          title={expanded ? 'Details chhupao' : 'Audio kis tab se aa raha hai — detail dikhao'}
          aria-label="Toggle media details"
          aria-expanded={expanded}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="transition-transform duration-200 {expanded ? 'rotate-90' : ''}"
          >
            <path d="m9 5 7 7-7 7" />
          </svg>
        </button>
      </div>

      {#if expanded}
        <div
          class="flex items-center justify-between gap-2 border-t border-white/10 px-4 py-1.5 text-[10px] text-white/60"
          transition:fade={{ duration: 120 }}
        >
          <span class="truncate">
            {playing ? 'Audio chal raha hai' : 'Media paused'} · tab {snap?.tab ?? '—'}
          </span>
          <button
            type="button"
            class="shrink-0 rounded px-1.5 py-0.5 text-nc-brand hover:bg-white/10"
            onclick={() => void mediaFlyoutPin(true).then((v) => (pinned = v))}
          >
            Keep open
          </button>
        </div>
      {/if}
    </div>

    <!-- Row 2: 02:22 ─────────●──────── 18:11 — the whole reason this
         window exists. Dragging updates local state only; the seek goes to
         the page on release, through the same action path as the earbud. -->
    <div class="flex items-center gap-2">
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
  </div>
{/if}

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
