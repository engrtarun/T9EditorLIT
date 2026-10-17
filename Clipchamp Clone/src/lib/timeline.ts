/**
 * Pure timeline operations.
 *
 * Every function here is side-effect free and returns new objects, so the
 * reactive store in `editor.svelte.ts` can treat the timeline as immutable
 * state and the tests can exercise the rules without a DOM or Tauri.
 *
 * Times are seconds (floats) throughout. Clips are half-open intervals
 * `[startSecs, startSecs + durationSecs)`.
 */

import type { Clip, LookAdjustments, TransitionKind } from "./types.js";

/** A clip plus the track it lives on, for operations needing both. */
export interface PlacedClip {
  clip: Clip;
  trackId: string;
}

export const EPSILON = 1e-6;

export function clipEnd(clip: Clip): number {
  return clip.startSecs + clip.durationSecs;
}

/** Snap `t` to `step`, unless it is already within `tolerance` of a step. */
export function snap(t: number, step: number, tolerance: number): number {
  if (step <= 0) return t;
  const nearest = Math.round(t / step) * step;
  return Math.abs(nearest - t) <= tolerance ? nearest : t;
}

/**
 * Remove `durationSecs` from the clip at `offsetSecs` inside `clip`.
 *
 * Clipchamp's split behaviour: the gap is closed, later clips shift left.
 * Returns null when the cut falls outside the clip or would leave nothing.
 */
export function splitClip(clip: Clip, offsetSecs: number): [Clip, Clip] | null {
  if (offsetSecs <= EPSILON || offsetSecs >= clip.durationSecs - EPSILON) return null;

  const head: Clip = {
    ...clip,
    durationSecs: offsetSecs,
    outPointSecs: clip.inPointSecs + offsetSecs,
  };
  const tail: Clip = {
    ...clip,
    id: `${clip.id}-split-${offsetSecs.toFixed(3)}`,
    startSecs: clip.startSecs + offsetSecs,
    durationSecs: clip.durationSecs - offsetSecs,
    inPointSecs: clip.inPointSecs + offsetSecs,
  };
  // A transition lives on the head; the tail starts clean.
  tail.transition = null;
  return [head, tail];
}

/**
 * Move a clip to a new start time, clamped so it cannot go negative.
 * `speed` is ignored: clip length is already timeline length.
 */
export function moveClip(clip: Clip, newStartSecs: number): Clip {
  return { ...clip, startSecs: Math.max(0, newStartSecs) };
}

/**
 * Trim the clip's right edge to `newDurationSecs`.
 *
 * Constrained by the source asset: you cannot expose footage that does not
 * exist, so the new out point may exceed the asset's usable material only
 * when the caller has not supplied a bound (pass 0 to disable).
 */
export function trimRight(clip: Clip, newDurationSecs: number, maxSourceSecs = 0): Clip {
  const MIN = 0.1;
  let duration = Math.max(MIN, newDurationSecs);

  // Clamp against the source asset so we never expose footage that isn't there.
  if (maxSourceSecs > 0) {
    const headroom = maxSourceSecs - clip.inPointSecs;
    if (headroom < MIN * clip.speed) {
      // Not enough material left to satisfy the minimum length.
      return { ...clip, durationSecs: MIN, outPointSecs: clip.inPointSecs + MIN * clip.speed };
    }
    duration = Math.min(duration, headroom / clip.speed);
  }

  return {
    ...clip,
    durationSecs: duration,
    outPointSecs: clip.inPointSecs + duration * clip.speed,
  };
}

/** Trim the clip's left edge, pulling the start earlier or later. */
export function trimLeft(clip: Clip, newStartSecs: number, minDurationSecs = 0.1): Clip {
  const newDuration = clip.durationSecs - (newStartSecs - clip.startSecs);
  if (newDuration < minDurationSecs) return clip;

  const delta = newStartSecs - clip.startSecs;
  const newInPoint = Math.max(0, clip.inPointSecs + delta * clip.speed);
  return {
    ...clip,
    startSecs: newStartSecs,
    durationSecs: newDuration,
    inPointSecs: newInPoint,
  };
}

/**
 * Do two clips on the same track overlap?
 *
 * Overlap is allowed on overlay tracks (Clipchamp layers them) and forbidden
 * on video/audio/caption tracks, where the renderer could only show one.
 */
export function overlaps(a: Clip, b: Clip, trackKind: string): boolean {
  if (trackKind === "overlay") return false;
  if (a.id === b.id) return false;
  return a.startSecs < clipEnd(b) - EPSILON && b.startSecs < clipEnd(a) - EPSILON;
}

/** First overlap between the candidate clip and its track, or null. */
export function findCollision(
  candidate: Clip,
  clips: readonly Clip[],
  trackKind: string,
): Clip | null {
  for (const c of clips) {
    if (overlaps(candidate, c, trackKind)) return c;
  }
  return null;
}

/**
 * Ripple-delete: drop `removedId` and close the gap it leaves behind.
 *
 * Only clips on the same track that start at or after the removed clip's start
 * shift left, so earlier clips keep their timing. `removedEndSecs` bounds the
 * gap rather than the clip's nominal duration, which keeps the result correct
 * for a trimmed clip.
 */
export function rippleDelete(
  clips: readonly Clip[],
  removedId: string,
  removedEndSecs: number,
  removedStartSecs: number,
): Clip[] {
  const gap = Math.max(0, removedEndSecs - removedStartSecs);
  return clips
    .filter((c) => c.id !== removedId)
    .map((c) =>
      c.startSecs >= removedStartSecs - EPSILON
        ? { ...c, startSecs: Math.max(0, c.startSecs - gap) }
        : { ...c },
    );
}

/** Total length of the timeline: the furthest clip end on any track. */
export function timelineDuration(tracks: readonly { clips: Clip[] }[]): number {
  let max = 0;
  for (const t of tracks) {
    for (const c of t.clips) max = Math.max(max, clipEnd(c));
  }
  return max;
}

/**
 * Render a look to the FFmpeg filter chain.
 *
 * Only non-identity adjustments are emitted so the common case passes no
 * filter at all — important on an i3, where every filter is CPU work.
 */
export function lookToFfmpeg(look: LookAdjustments): string {
  const parts: string[] = [];
  const { brightness, contrast, saturation } = look;

  if (brightness !== 0 || contrast !== 0 || saturation !== 0) {
    const b = (brightness * 0.5).toFixed(3); // eq wants -1..1, we hold -0.5..0.5
    const c = (1 + contrast).toFixed(3);
    const s = (1 + saturation).toFixed(3);
    parts.push(`eq=brightness=${b}:contrast=${c}:saturation=${s}`);
  }
  if (look.temperature !== 0 || look.tint !== 0) {
    const t = Math.round(look.temperature * 5000);
    const g = Math.round(look.tint * 5000);
    parts.push(`colortemperature=temperature=${t}:tint=${g}`);
  }
  if (look.vignette > 0) parts.push(`vignette=PI/${look.vignette.toFixed(3)}`);
  return parts.join(",");
}

/** FFmpeg transition filter for a clip head, or null when untransitioned. */
export function transitionToFfmpeg(
  kind: TransitionKind | null,
  durationSecs: number,
): string | null {
  if (!kind || durationSecs <= 0) return null;
  const d = Math.min(durationSecs, 2).toFixed(2);
  switch (kind) {
    case "crossfade":
    case "dissolve":
      return `xfade=transition=fade:duration=${d}`;
    case "dip_to_black":
      return `fade=t=in:st=0:d=${d},fade=t=out:st=0:d=${d}`;
    case "wipe":
      return `xfade=transition=wipeleft:duration=${d}`;
    default:
      return null;
  }
}

/** Format seconds as `M:SS.cs` for timeline and transport readouts. */
export function formatTimecode(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const cs = Math.floor((secs % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}
