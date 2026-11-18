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

/** A selection that knows which row it belongs to. */
export interface LineWordSelection extends WordSelection {
  /** `data-line-id` of the row that owns the selected text. */
  lineId: string;
}

/**
 * Report a word selection **while it is being dragged**.
 *
 * The old flow listened for `mouseup`, so the toolbar appeared only after the
 * mouse was released — and a drag that ended outside the row showed nothing
 * at all. `selectionchange` fires on the first selected character and again
 * as the selection grows, which is what makes the confirmation feel instant.
 *
 * `root` scopes the watcher to one panel: the transcript and the strip below
 * the video each own their toolbar, and neither may react to the other's
 * selection. All state reads happen when the event fires, never at install
 * time, so the watcher itself cannot re-run on every keystroke.
 *
 * A selection that leaves the root is reported as `null`: the pending toolbar
 * belongs to a selection, and a selection elsewhere means it is gone.
 */
export function watchWordSelection(
  root: () => HTMLElement | null | undefined,
  onPick: (hit: LineWordSelection | null) => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The last reported range, so a 60 fps drag does not rebuild the toolbar. */
  let last = '';

  const report = (hit: LineWordSelection | null) => {
    const key = hit ? `${hit.lineId}:${hit.from}:${hit.to}` : '';
    if (key === last) return;
    last = key;
    onPick(hit);
  };

  const read = () => {
    timer = null;
    const host = root();
    const sel = window.getSelection();
    if (!host || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      report(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) {
      report(null);
      return;
    }
    const node = range.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const textEl = el?.closest<HTMLElement>('[data-line-text]');
    const row = textEl?.closest<HTMLElement>('[data-line-id]');
    const lineId = row?.dataset.lineId ?? '';
    if (!textEl || !lineId || !host.contains(textEl)) {
      report(null);
      return;
    }
    const picked = readWordSelection(textEl);
    report(picked ? { ...picked, lineId } : null);
  };

  // One read per tick: dragging fires far more often than the screen paints,
  // and every read measures the selection box. A zero-delay timer (not rAF)
  // because rAF is suspended while the window is occluded or minimised — the
  // toolbar would then appear only after the user came back.
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(read, 0);
  };

  document.addEventListener('selectionchange', schedule);
  return () => {
    document.removeEventListener('selectionchange', schedule);
    if (timer !== null) clearTimeout(timer);
  };
}
