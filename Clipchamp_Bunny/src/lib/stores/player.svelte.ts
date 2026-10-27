class PlayerStore {
  currentTime = $state(0);
  playing = $state(false);
  /** px per second on the bottom timeline. */
  zoom = $state(35);
  /** Magnet on the timeline — snaps the playhead to line boundaries. */
  snap = $state(true);
  /** Preview loop — when the project runs out of media it rewinds to its
   *  first kept second and keeps playing, instead of stopping. Nothing is
   *  re-encoded; the toggle lives on the preview bar's Size pill. */
  loop = $state(false);

  /** Registered <video> element. Held weakly-ish: cleared on mode teardown. */
  el: HTMLVideoElement | null = null;

  /** `performance.now()` of the last programmatic seek. */
  seekAt = 0;
  /** The time that seek asked for. */
  seekTarget = 0;

  attach(el: HTMLVideoElement | null) {
    this.el = el;
    if (el) this.currentTime = el.currentTime || 0;
  }

  seek(sec: number) {
    this.currentTime = sec;
    this.seekAt = performance.now();
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
   */
  isStaleUpdate(actual: number): boolean {
    if (!this.seekAt) return false;
    if (performance.now() - this.seekAt > 800) return false;
    return Math.abs(actual - this.seekTarget) > 0.25;
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
