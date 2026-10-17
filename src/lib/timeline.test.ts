import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatClock,
  frameIndexAt,
  frameTime,
  thumbFileName,
  thumbStep,
} from "./timeline-utils.ts";

test("thumbFileName is one-based and zero-padded", () => {
  assert.equal(thumbFileName(0), "thumb_00001.jpg");
  assert.equal(thumbFileName(12), "thumb_00013.jpg");
  assert.equal(thumbFileName(12345), "thumb_12346.jpg");
});

test("thumbStep stays at 1 for small strips and decimates long ones", () => {
  assert.equal(thumbStep(300), 1);
  assert.equal(thumbStep(301), 2);
  assert.equal(thumbStep(7200, 300), 24);
  assert.equal(thumbStep(0), 1);
});

test("frameIndexAt snaps to the nearest cached frame and rejects out-of-range", () => {
  assert.equal(frameIndexAt(0, 1, 100), 0);
  assert.equal(frameIndexAt(7.4, 1, 100), 7);
  assert.equal(frameIndexAt(7.6, 1, 100), 8);
  assert.equal(frameIndexAt(-1, 1, 100), -1);
  assert.equal(frameIndexAt(100, 1, 100), -1);
  assert.equal(frameIndexAt(5, 0, 100), -1);
});

test("frameTime converts a frame index to seconds", () => {
  assert.equal(frameTime(0, 1), 0);
  assert.equal(frameTime(90, 1), 90);
  assert.equal(frameTime(45, 2), 22.5);
  assert.equal(frameTime(5, 0), 0);
});

test("formatClock renders MM:SS", () => {
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(7), "00:07");
  assert.equal(formatClock(90), "01:30");
  assert.equal(formatClock(-5), "00:00");
});
