class PlayerStore {
  currentTime = $state(0);
  playing = $state(false);
  /** px per second on the bottom timeline. */
  zoom = $state(35);
  /** Magnet on the timeline — snaps the playhead to line boundaries. */
  snap = $state(true);
  /**
   * Preview mode toggle: `false` = **applied edits** (the Phantom Cut skips
   * every red/grey block), `true` = **raw source** (cut material plays
   * exactly as recorded — nothing is skipped). Nothing is re-encoded in
   * either mode; the timeupdate loop simply stops refusing cut ranges.
   */
  previewRaw = $state(false);
  /** Preview loop — when the project runs out of media it rewinds to its
   *  first kept second and keeps playing, instead of stopping. Nothing is
   *  re-encoded; the toggle lives on the preview bar's Size pill. */
  loop = $state(false);

  /**
   * Registered <video> element. Held weakly-ish: cleared on mode teardown.
   *
   * Reactive on purpose: the ambient glow on the preview bar and the timeline
   * tool row samples *this* element, and it appears (`loadeddata`) and
   * disappears (mode teardown, image clip) at unpredictable moments — the
   * glow has to follow those transitions, not poll for them. Not proxied by
   * Svelte (non-plain object), so identity checks like `player.el === v`
   * still hold.
   */
  el: HTMLVideoElement | null = $state(null);

  /** `performance.now()` of the last programmatic seek. */
  seekAt = 0;
  /** The time that seek asked for. */
  seekTarget = 0;
  /**
   * Where the element was when that seek started. A `timeupdate` that still
   * reports this pre-seek position belongs to the renderer's old state, no
   * matter which direction we seeked.
   */
  seekFrom = 0;

  attach(el: HTMLVideoElement | null) {
    this.el = el;
    if (el) this.currentTime = el.currentTime || 0;
  }

  seek(sec: number) {
    this.currentTime = sec;
    this.seekAt = performance.now();
    this.seekFrom = this.el?.currentTime ?? this.currentTime;
    this.seekTarget = sec;
    if (this.el) {
      try {
        this.el.currentTime = sec;
      } catch {
        /* metadata not loaded yet — ignore */
      }
    }
  }

  /**
   * True when a `<video>` `timeupdate` still reports the position from before a
   * seek we just asked for. Without this, a skip button moved the label and the
   * very next timeupdate snapped it back to the old second.
   *
   * The comparison is against the position the seek *left*, not its target.
   * The old target comparison called every legitimately advancing update
   * "stale" once playback had moved 0.25 s past the target - for 800 ms after
   * each cut skip the playhead label froze and cut ranges went unenforced, so
   * cut audio kept playing. The renderer reports the old frame until the seek
   * lands, so "still at the old position" is the honest stale test.
   */
  isStaleUpdate(actual: number): boolean {
    if (!this.seekAt) return false;
    if (performance.now() - this.seekAt > 800) return false;
    return Math.abs(actual - this.seekFrom) < 0.05 && Math.abs(actual - this.seekTarget) > 0.01;
  }

  toggle() {
    this.playing = !this.playing;
    if (this.el) {
      if (this.playing) void this.el.play().catch(() => (this.playing = false));
      else this.el.pause();
    }
  }

  toggleLoop() {
    this.loop = !this.loop;
  }

  nudge(deltaSec: number) {
    this.seek(Math.max(0, this.currentTime + deltaSec));
  }
}

export const player = new PlayerStore();
