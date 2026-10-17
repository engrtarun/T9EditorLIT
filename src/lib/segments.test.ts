import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentsFromTranscript, summarizeSegments, formatDuration } from "./segments.ts";

test("segmentsFromTranscript merges adjacent kept lines", () => {
  const lines = [
    { startSecs: 0, endSecs: 2, keep: true },
    { startSecs: 2, endSecs: 4, keep: true },
    { startSecs: 4, endSecs: 6, keep: false },
    { startSecs: 6, endSecs: 8, keep: true },
  ];
  const segs = segmentsFromTranscript(lines, 10);
  assert.deepEqual(segs, [
    { start: 0, end: 4 },
    { start: 6, end: 8 },
  ]);
});

test("segmentsFromTranscript drops cut lines", () => {
  const lines = [
    { startSecs: 0, endSecs: 3, keep: false },
    { startSecs: 3, endSecs: 5, keep: true },
  ];
  const segs = segmentsFromTranscript(lines, 10);
  assert.deepEqual(segs, [{ start: 3, end: 5 }]);
});

test("segmentsFromTranscript clamps to duration", () => {
  const lines = [{ startSecs: 8, endSecs: 15, keep: true }];
  const segs = segmentsFromTranscript(lines, 10);
  assert.deepEqual(segs, [{ start: 8, end: 10 }]);
});

test("segmentsFromTranscript returns empty when nothing kept", () => {
  const lines = [
    { startSecs: 0, endSecs: 5, keep: false },
    { startSecs: 5, endSecs: 10, keep: false },
  ];
  const segs = segmentsFromTranscript(lines, 10);
  assert.deepEqual(segs, []);
});

test("summarizeSegments computes kept and cut", () => {
  const segs = [
    { start: 0, end: 30 },
    { start: 60, end: 90 },
  ];
  const sum = summarizeSegments(segs, 120);
  assert.equal(sum.keptSecs, 60);
  assert.equal(sum.cutSecs, 60);
  assert.equal(sum.segmentCount, 2);
});

test("formatDuration handles hours and milliseconds", () => {
  assert.equal(formatDuration(3725.5), "01:02:05.500");
  assert.equal(formatDuration(75.25), "01:15.250");
  assert.equal(formatDuration(9.5), "00:09.500");
  assert.equal(formatDuration(-1), "--:--");
  assert.equal(formatDuration(NaN), "--:--");
});
