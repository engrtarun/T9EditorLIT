/**
 * Trim maths, shared by the keyboard trims, the timeline handles and the
 * segment trims.
 *
 * The fixed 0.3 s floor was written for ordinary transcript rows. A word cut
 * can leave a row of 80-200 ms, and there a floor longer than the row itself
 * does not protect anything: `trimStart` clamped the start to `end - 0.3`,
 * which is *before* the start, so the row grew backwards; the segment trims
 * refused the gesture outright. A proportional floor always leaves a real
 * piece and can never invert the range.
 */

/** Smallest span a trim may leave: 0.3 s for a normal clip, half for a sliver. */
export function trimKeep(span: number): number {
  return Math.min(0.3, Math.max(0, span) / 2);
}

/** Smallest pointer movement that counts as a trim, so a sloppy click is not an edit. */
export function trimStep(span: number): number {
  return Math.min(0.02, Math.max(0, span) / 4);
}

/**
 * New start after a trim. Never lands before 0, never crosses the end, and
 * always leaves `trimKeep` behind — so a 120 ms row cannot grow backwards.
 */
export function nextTrimStart(start: number, end: number, delta: number): number {
  return Math.max(0, Math.min(end - trimKeep(end - start), start + delta));
}

/** New end after a trim. The mirror of `nextTrimStart`: never crosses the start. */
export function nextTrimEnd(start: number, end: number, delta: number): number {
  return Math.max(start + trimKeep(end - start), end + delta);
}
