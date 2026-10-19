class PlayerStore {
  currentTime = $state(0);
  playing = $state(false);
  /** px per second on the bottom timeline. */
  zoom = $state(35);
  /** Magnet on the timeline — snaps the playhead to line boundaries. */
  snap = $state(true);

  /** Registered <video> element. Held weakly-ish: cleared on mode teardown. */
  el: HTMLVideoElement | null = null;

  attach(el: HTMLVideoElement | null) {
    this.el = el;
    if (el) this.currentTime = el.currentTime || 0;
  }

  seek(sec: number) {
    this.currentTime = sec;
    if (this.el) {
      try {
        this.el.currentTime = sec;
      } catch {
        /* metadata not loaded yet — ignore */
      }
    }
  }

  toggle() {
    this.playing = !this.playing;
    if (this.el) {
      if (this.playing) void this.el.play().catch(() => (this.playing = false));
      else this.el.pause();
    }
  }

  nudge(deltaSec: number) {
    this.seek(Math.max(0, this.currentTime + deltaSec));
  }
}

export const player = new PlayerStore();
