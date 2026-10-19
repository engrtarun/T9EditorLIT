export type ToastKind = 'info' | 'cut' | 'keep' | 'split' | 'warn';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

/**
 * Lightweight feedback queue. The notebook asked for "satisfying micro feedback"
 * on every cut — this is it. Auto-dismisses, never blocks, never queues more
 * than a few.
 */
class ToastStore {
  items = $state<Toast[]>([]);
  private seq = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];

  push(kind: ToastKind, text: string, ms = 1400) {
    const id = ++this.seq;
    this.items = [...this.items.slice(-3), { id, kind, text }];
    const t = setTimeout(() => this.dismiss(id), ms);
    this.timers.push(t);
  }

  dismiss(id: number) {
    this.items = this.items.filter((x) => x.id !== id);
  }

  clear() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.items = [];
  }
}

export const toast = new ToastStore();
