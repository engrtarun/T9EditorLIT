import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTrimEnd, nextTrimStart, trimKeep, trimStep } from './trim.ts';

test('a normal clip keeps the familiar 0.3 s floor', () => {
  assert.equal(trimKeep(10), 0.3);
  assert.equal(trimKeep(0.6), 0.3);
  assert.equal(trimStep(10), 0.02);
});

test('a word-cut sliver keeps half of itself, never more than it has', () => {
  // 120 ms word: the old 0.3 s floor was longer than the row, so trimming its
  // start pushed the start before the end. Half the span always leaves a piece.
  assert.equal(trimKeep(0.12), 0.06);
  assert.equal(trimKeep(0.04), 0.02);
  assert.equal(trimStep(0.04), 0.01);
  assert.ok(trimKeep(0.12) < 0.12);
});

test('a zero or negative span cannot produce a negative floor', () => {
  assert.equal(trimKeep(0), 0);
  assert.equal(trimKeep(-2), 0);
  assert.equal(trimStep(0), 0);
  assert.equal(trimStep(-2), 0);
});

test('the floors never exceed half / a quarter of the span', () => {
  for (const span of [0.01, 0.02, 0.05, 0.1, 0.25, 0.59, 0.6, 1, 60]) {
    assert.ok(trimKeep(span) <= span / 2 + 1e-9, `keep ${span}`);
    assert.ok(trimStep(span) <= span / 4 + 1e-9, `step ${span}`);
  }
});

test('trimming a 120 ms word row can never put the start before the end', () => {
  // The old clamp was `end - 0.3`: for this row that is *before* the start, so
  // pressing Z+→ grew the row backwards instead of trimming it. Half a span
  // leaves exactly 60 ms, and further presses shrink it without ever inverting.
  const start = 10;
  const end = 10.12;
  let s = start;
  let e = end;
  for (let i = 0; i < 4; i++) {
    s = nextTrimStart(s, e, 0.1);
    assert.ok(s < e, `start ${s} must stay before end ${e}`);
  }
  assert.ok(Math.abs(nextTrimStart(start, end, 1) - 10.06) < 1e-9);

  let s2 = start;
  let e2 = end;
  for (let i = 0; i < 4; i++) {
    e2 = nextTrimEnd(s2, e2, -0.1);
    assert.ok(e2 > s2, `end ${e2} must stay after start ${s2}`);
  }
  assert.ok(Math.abs(nextTrimEnd(start, end, -1) - 10.06) < 1e-9);
});
