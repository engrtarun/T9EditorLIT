import type { Mode } from '../types';

const ORDER: Mode[] = ['ingest', 'cut', 'polish', 'export'];

export const MODE_LABEL: Record<Mode, string> = {
  ingest: '1 · Ingest',
  cut: '2 · 7:3 Cut',
  polish: '3 · Polish',
  export: '4 · Export'
};

class ModeStore {
  current = $state<Mode>('cut');
  /** Incremented on every switch — App.svelte uses it as the #key so the previous
   *  mode's component tree is destroyed, not just hidden. That is the zero-RAM trick. */
  epoch = $state(0);

  set(next: Mode) {
    if (next === this.current) return;
    this.current = next;
    this.epoch++;
  }

  next() {
    this.set(ORDER[(ORDER.indexOf(this.current) + 1) % ORDER.length]);
  }
}

export const mode = new ModeStore();
