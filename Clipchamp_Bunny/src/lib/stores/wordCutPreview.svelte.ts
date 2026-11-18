/**
 * The word cut that is currently *pending* — selected in the transcript or in
 * the strip under the video, not yet confirmed.
 *
 * Why a store instead of component state: the confirmation toolbar and the
 * bottom timeline are siblings, and a timeline that cannot see the selection
 * cannot show what it will remove. The user asked for exactly that: select
 * words, and the lane under the video paints the range blue before anything
 * is cut.
 *
 * Only source seconds cross the boundary. The timeline maps them through its
 * own segments (`timelineSpansForSource`), so the band stays correct when the
 * selection crosses a clip boundary or sits over an already-cut block.
 *
 * `owner` stops the two selection watchers (transcript panel, video strip)
 * from clearing each other: a selection in one of them makes the other
 * watcher report `null` on the same `selectionchange`, and that null must not
 * erase a live highlight.
 */
export type WordCutOwner = 'transcript' | 'strip';

export interface PendingWordCutRange {
  /** Source seconds, inclusive. */
  fromSec: number;
  /** Source seconds, exclusive. */
  toSec: number;
}

class WordCutPreview {
  owner = $state<WordCutOwner | null>(null);
  /** One range per row the selection touches (multi-line selections). */
  ranges = $state<ReadonlyArray<PendingWordCutRange>>([]);
  /** The selected words as they appear in the transcript. */
  text = $state('');
  /** Boundaries came from the character-count fallback, not word timings. */
  approx = $state(false);
  /** `snapPlanToAudio` pulled the boundaries onto a real pause. */
  snapped = $state(false);

  /** True while the timeline should paint the band. */
  get active(): boolean {
    return this.ranges.length > 0;
  }

  /** Total source seconds the pending cut would remove. */
  get spanSec(): number {
    let total = 0;
    for (const r of this.ranges) total += Math.max(0, r.toSec - r.fromSec);
    return total;
  }

  /**
   * Publish a pending cut. `owner` is the surface the selection lives in;
   * the other surface's `null` report is ignored by `clear`.
   */
  set(
    owner: WordCutOwner,
    ranges: ReadonlyArray<PendingWordCutRange>,
    text: string,
    approx: boolean,
    snapped: boolean
  ) {
    const clean = ranges.filter((r) => r.toSec - r.fromSec > 1e-4);
    this.owner = owner;
    this.ranges = clean;
    this.text = text;
    this.approx = approx;
    this.snapped = snapped;
  }

  /**
   * Drop the highlight. With an `owner`, only that owner can clear it — the
   * sibling watcher firing `null` for a selection it never owned is not a
   * reason to erase the band.
   */
  clear(owner?: WordCutOwner) {
    if (owner && this.owner !== owner) return;
    this.owner = null;
    this.ranges = [];
    this.text = '';
    this.approx = false;
    this.snapped = false;
  }
}

export const wordCutPreview = new WordCutPreview();
