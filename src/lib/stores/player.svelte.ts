/**
 * Shared handle to the Stage <video> element.
 *
 * Stage owns the element (it is the only place a <video> is mounted, per the
 * mode-isolation rule); CutMode and keyboard handlers reach it through here
 * instead of holding their own references.
 */
class PlayerStore {
  element = $state<HTMLVideoElement | null>(null);

  setElement(el: HTMLVideoElement | null): void {
    this.element = el;
  }

  get currentTime(): number {
    return this.element?.currentTime ?? 0;
  }

  seek(seconds: number): void {
    if (!this.element) return;
    const clamped = Math.max(0, Math.min(seconds, this.element.duration || seconds));
    this.element.currentTime = clamped;
  }

  togglePlay(): void {
    if (!this.element) return;
    if (this.element.paused) {
      void this.element.play();
    } else {
      this.element.pause();
    }
  }

  scrub(delta: number): void {
    if (!this.element) return;
    this.seek(this.element.currentTime + delta);
  }
}

export const player = new PlayerStore();
