import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clipEnd,
  findCollision,
  formatTimecode,
  lookToFfmpeg,
  moveClip,
  overlaps,
  rippleDelete,
  snap,
  splitClip,
  timelineDuration,
  transitionToFfmpeg,
  trimLeft,
  trimRight,
} from "./timeline.ts";
import { neutralLook, type Clip } from "./types.ts";

/** Build a clip with sensible defaults so each test states only what it cares about. */
function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: "c1",
    assetId: "a1",
    trackId: "t1",
    startSecs: 0,
    durationSecs: 10,
    inPointSecs: 0,
    outPointSecs: 10,
    speed: 1,
    volume: 1,
    muted: false,
    transition: null,
    ...over,
  };
}

test("clipEnd is start + duration", () => {
  assert.equal(clipEnd(clip({ startSecs: 5, durationSecs: 2.5 })), 7.5);
});

test("snap pulls to the nearest step only within tolerance", () => {
  // Inside tolerance: snaps.
  assert.equal(snap(10.04, 1, 0.1), 10);
  assert.equal(snap(10.95, 1, 0.1), 11);
  // Outside tolerance: left alone rather than dragged.
  assert.equal(snap(10.4, 1, 0.1), 10.4);
  assert.equal(snap(10.6, 1, 0.1), 10.6);
});

test("snap with a zero or negative step is a no-op", () => {
  assert.equal(snap(7.3, 0, 1), 7.3);
  assert.equal(snap(7.3, -1, 1), 7.3);
});

test("splitClip halves duration and advances the tail's in point", () => {
  const [head, tail] = splitClip(clip({ durationSecs: 10, inPointSecs: 2 }), 4)!;
  assert.equal(head.durationSecs, 4);
  assert.equal(head.outPointSecs, 6);
  assert.equal(tail.startSecs, 4);
  assert.equal(tail.durationSecs, 6);
  assert.equal(tail.inPointSecs, 6);
  assert.notEqual(head.id, tail.id);
});

test("splitClip at the edges returns null so no zero-length clip is made", () => {
  assert.equal(splitClip(clip(), 0), null);
  assert.equal(splitClip(clip({ durationSecs: 10 }), 10), null);
});

test("splitClip moves the transition to the head and leaves the tail clean", () => {
  const [head, tail] = splitClip(clip({ transition: "crossfade" }), 5)!;
  assert.equal(head.transition, "crossfade");
  assert.equal(tail.transition, null);
});

test("moveClip clamps at zero instead of going negative", () => {
  assert.equal(moveClip(clip(), -3).startSecs, 0);
  assert.equal(moveClip(clip(), 12).startSecs, 12);
});

test("trimRight honours the minimum length", () => {
  assert.equal(trimRight(clip(), 0.01).durationSecs, 0.1);
});

test("trimRight will not expose source material that does not exist", () => {
  // 6s of source available from inPoint, so a 10s trim clamps to 6s.
  const t = trimRight(clip({ durationSecs: 10, inPointSecs: 0 }), 20, 6);
  assert.equal(t.durationSecs, 6);
  assert.equal(t.outPointSecs, 6);
});

test("trimRight scales the available source by clip speed", () => {
  // 2x speed consumes source twice as fast: 6s of source becomes 3s of timeline.
  const t = trimRight(clip({ speed: 2, inPointSecs: 0 }), 30, 6);
  assert.equal(t.durationSecs, 3);
  assert.equal(t.outPointSecs, 6);
});

test("trimLeft pulls the head later and shortens the clip", () => {
  const t = trimLeft(clip({ startSecs: 10, durationSecs: 10, inPointSecs: 10 }), 13);
  assert.equal(t.startSecs, 13);
  assert.equal(t.durationSecs, 7);
  assert.equal(t.inPointSecs, 13);
});

test("trimLeft refuses to shorten past the minimum", () => {
  const original = clip({ startSecs: 10, durationSecs: 10 });
  assert.deepEqual(trimLeft(original, 19.95), original);
});

test("overlaps detects a collision on a linear track", () => {
  const a = clip({ id: "a", startSecs: 0, durationSecs: 5 });
  const b = clip({ id: "b", startSecs: 4, durationSecs: 5 });
  assert.equal(overlaps(a, b, "video"), true);
});

test("overlaps treats touching clips as non-overlapping (half-open intervals)", () => {
  const a = clip({ id: "a", startSecs: 0, durationSecs: 5 });
  const b = clip({ id: "b", startSecs: 5, durationSecs: 5 });
  assert.equal(overlaps(a, b, "video"), false);
});

test("overlaps always allows stacking on an overlay track", () => {
  const a = clip({ id: "a", startSecs: 0, durationSecs: 5 });
  const b = clip({ id: "b", startSecs: 1, durationSecs: 5 });
  assert.equal(overlaps(a, b, "overlay"), false);
});

test("findCollision ignores the candidate's own clip and reports the first real blocker", () => {
  const a = clip({ id: "a", startSecs: 0, durationSecs: 5 });
  const later = clip({ id: "later", startSecs: 30, durationSecs: 5 });
  const blocker = clip({ id: "blocker", startSecs: 3, durationSecs: 5 });

  assert.equal(findCollision(a, [later], "video"), null);
  assert.equal(findCollision(a, [a, later, blocker], "video")?.id, "blocker");
});

test("rippleDelete removes the clip and closes the gap for later clips", () => {
  const before = clip({ id: "a", startSecs: 0, durationSecs: 5 });
  const removed = clip({ id: "b", startSecs: 5, durationSecs: 5 });
  const after = clip({ id: "c", startSecs: 10, durationSecs: 5 });

  const out = rippleDelete([before, removed, after], "b", 10, 5);
  assert.deepEqual(
    out.map((c) => [c.id, c.startSecs]),
    [
      ["a", 0],
      ["c", 5],
    ],
  );
});

test("rippleDelete never pushes a clip below zero", () => {
  const clips = [clip({ id: "a", startSecs: 1, durationSecs: 5 })];
  const [shifted] = rippleDelete(clips, "missing", 100, 0);
  assert.equal(shifted?.startSecs, 0);
});

test("timelineDuration takes the furthest clip end across all tracks", () => {
  const tracks = [
    { clips: [clip({ startSecs: 0, durationSecs: 3 })] },
    { clips: [clip({ startSecs: 12, durationSecs: 4 })] },
  ];
  assert.equal(timelineDuration(tracks), 16);
});

test("lookToFfmpeg emits nothing for an identity look", () => {
  assert.equal(lookToFfmpeg(neutralLook()), "");
});

test("lookToFfmpeg emits only the filters that are actually active", () => {
  const out = lookToFfmpeg({ ...neutralLook(), saturation: 0.5 });
  assert.match(out, /^eq=/);
  assert.match(out, /saturation=1\.500/);
  assert.ok(!out.includes("vignette"));
});

test("lookToFfmpeg maps temperature and vignette", () => {
  const out = lookToFfmpeg({ ...neutralLook(), temperature: 0.5, vignette: 0.25 });
  assert.match(out, /colortemperature=temperature=2500/);
  assert.match(out, /vignette=PI\/0\.250/);
});

test("transitionToFfmpeg maps each transition kind, or null when absent", () => {
  assert.equal(transitionToFfmpeg(null, 2), null);
  assert.equal(transitionToFfmpeg("crossfade", 0), null);
  assert.match(transitionToFfmpeg("crossfade", 1)!, /xfade=transition=fade:duration=1\.00/);
  assert.match(transitionToFfmpeg("wipe", 1)!, /wipeleft/);
  assert.match(transitionToFfmpeg("dip_to_black", 1)!, /fade=t=in/);
});

test("formatTimecode renders minutes, seconds and centiseconds", () => {
  assert.equal(formatTimecode(0), "0:00.00");
  assert.equal(formatTimecode(9.5), "0:09.50");
  assert.equal(formatTimecode(75.25), "1:15.25");
});

test("formatTimecode clamps negatives and non-finite input", () => {
  assert.equal(formatTimecode(-4), "0:00.00");
  assert.equal(formatTimecode(Number.NaN), "0:00.00");
});
