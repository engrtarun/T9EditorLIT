/**
 * Shared handle to the Stage <video> element.
 *
 * Stage owns the element (it is the only place a <video> is mounted, per the
 * mode-isolation rule); CutMode, the timeline and the keyboard layer reach it
 * through here instead of holding their own references.
 *
 * Every method is a no-op when no element is bound yet, so a shortcut can
 * safely fire while the stage is still mounting.
 */
class PlayerStore {
  element = $state<HTMLVideoElement | null>(null);

  setElement(el: HTMLVideoElement | null): void {
    this.element = el;
  }

  get currentTime(): number {
    return this.element?.currentTime ?? 0;
  }

  get duration(): number {
    const d = this.element?.duration ?? 0;
    return Number.isFinite(d) ? d : 0;
  }

  get playing(): boolean {
    return this.element ? !this.element.paused : false;
  }

  get muted(): boolean {
    return this.element?.muted ?? false;
  }

  get volume(): number {
    return this.element?.volume ?? 1;
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

  /** Volume in 0.05 steps, clamped — the same granularity the player uses. */
  nudgeVolume(delta: number): void {
    if (!this.element) return;
    this.element.muted = false;
    this.element.volume = Math.max(0, Math.min(1, this.element.volume + delta));
  }

  toggleMute(): void {
    if (!this.element) return;
    this.element.muted = !this.element.muted;
  }

  /** Seek to the very end; fires the `ended` state rather than looping. */
  toEnd(): void {
    if (!this.element) return;
    this.seek(this.duration);
  }
}

export const player = new PlayerStore();
