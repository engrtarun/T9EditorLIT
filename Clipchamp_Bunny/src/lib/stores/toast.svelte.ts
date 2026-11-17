export type ToastKind = 'info' | 'cut' | 'keep' | 'split' | 'warn';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  /** How long this toast lives, in ms — the UI drains its bar against it. */
  ms: number;
}

/**
 * Lightweight feedback queue. The notebook asked for "satisfying micro feedback"
 * on every cut — this is it. Auto-dismisses, never blocks, never queues more
 * than a few.
 *
 * `pause` / `resume` exist because a timer the user cannot read is a timer that
 * steals the message: hovering or focusing a toast stops its clock, and leaving
 * restarts it for whatever was left. The store owns the *deadline*, so pausing
 * is just "remember how long is left" and resuming is "arm it again" — no
 * second clock to drift out of step with the first.
 */
class ToastStore {
  items = $state<Toast[]>([]);
  private seq = 0;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** When each running toast is due to leave (epoch ms). */
  private deadline = new Map<number, number>();
  /** Milliseconds left on a paused toast; present only while paused. */
  private held = new Map<number, number>();

  push(kind: ToastKind, text: string, ms = 2800) {
    const id = ++this.seq;
    this.items = [...this.items.slice(-3), { id, kind, text, ms }];
    this.arm(id, ms);
  }

  private arm(id: number, ms: number) {
    this.deadline.set(id, Date.now() + ms);
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), ms)
    );
  }

  pause(id: number) {
    const t = this.timers.get(id);
    if (!t) return;
    clearTimeout(t);
    this.timers.delete(id);
    this.held.set(id, Math.max((this.deadline.get(id) ?? Date.now()) - Date.now(), 0));
  }

  resume(id: number) {
    if (this.timers.has(id)) return;
    const left = this.held.get(id);
    this.held.delete(id);
    if (left === undefined) return;
    // A toast already at (or past) zero while hovered leaves the moment it is let go.
    this.arm(id, left);
  }

  dismiss(id: number) {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.deadline.delete(id);
    this.held.delete(id);
    this.items = this.items.filter((x) => x.id !== id);
  }

  clear() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.deadline.clear();
    this.held.clear();
    this.items = [];
  }
}

export const toast = new ToastStore();
