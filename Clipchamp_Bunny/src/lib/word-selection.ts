/**
 * Turn the browser's text selection into character offsets inside **one**
 * element, plus the on-screen box the selection occupies.
 *
 * Why character offsets: the word timings in `line.words` are indexed by the
 * words of `line.text`, so a pixel position is useless to the cutter. The
 * offsets are what `planWordCut` understands.
 *
 * Why the box: the confirmation toolbar is anchored to the words the user
 * dragged over (Descript / Notion behaviour) instead of living in a fixed
 * footer. The action then appears where the eye already is — a selection that
 * silently does nothing is the bug this prevents.
 */
export interface WordSelection {
  /** Start offset in the host's `textContent`, inclusive. */
  from: number;
  /** End offset in the host's `textContent`, exclusive. */
  to: number;
  /** The selected words, trimmed. */
  text: string;
  /** Viewport rectangle of the selected range — the anchor for the toolbar. */
  rect: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
  };
}

/**
 * Read the current selection, but only when it lives entirely inside `host`.
 *
 * Returns `null` for a plain click, a whitespace-only drag, and a selection
 * that starts in another row: a word cut belongs to exactly one line.
 */
export function readWordSelection(host: HTMLElement | null | undefined): WordSelection | null {
  if (!host) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;

  const before = range.cloneRange();
  before.selectNodeContents(host);
  before.setEnd(range.startContainer, range.startOffset);
  const from = before.toString().length;

  const whole = host.textContent ?? '';
  const to = Math.min(whole.length, from + range.toString().length);
  const text = whole.slice(from, to).trim();
  if (!text || to <= from) return null;

  const box = range.getBoundingClientRect();
  return {
    from,
    to,
    text,
    rect: {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height
    }
  };
}

/** The words in a selection — "3 words" is easier to judge than a character count. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
