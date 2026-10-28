/**
 * Where a library tile would land on the bottom timeline while it is in the
 * air.
 *
 * The media panel owns the gesture (pointer events, because the desktop
 * window's `dragDropEnabled` blocks HTML5 drag inside WebView2) and publishes
 * the slot here; the timeline paints the caret. Only an index and a pixel
 * position cross the boundary — the two components never have to agree about
 * segment geometry.
 */
class DropTarget {
  /** Insertion index among the extra clips — 0 means "before the first". */
  index = $state<number | null>(null);
  /** Caret position inside the lane element, in px. */
  x = $state<number | null>(null);

  set(index: number | null, x: number | null) {
    this.index = index;
    this.x = x;
  }

  clear() {
    this.index = null;
    this.x = null;
  }
}

export const dropTarget = new DropTarget();
