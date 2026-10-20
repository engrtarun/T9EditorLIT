import type { MenuItem } from '../types';

/**
 * One menu at a time, rendered at the **app root**.
 *
 * It used to live inside whichever panel opened it, which meant an ancestor
 * with a stacking context could hide it, and there was no click-away catcher —
 * so it opened and then refused to close.
 */
class MenuStore {
  current = $state<{
    items: MenuItem[];
    x: number;
    y: number;
    onchoose?: (id: string) => void;
  } | null>(null);

  show(items: MenuItem[], x: number, y: number, onchoose?: (id: string) => void) {
    this.current = { items, x, y, onchoose };
  }

  close() {
    this.current = null;
  }

  choose(id: string) {
    const cb = this.current?.onchoose;
    this.current = null;
    cb?.(id);
  }
}

export const menu = new MenuStore();
