import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clamp, fmtHuman, fmtShort, fmtSize, fmtTime, niceStep } from './utils.ts';

test('fmtTime renders m:ss.cc and clamps negatives to zero', () => {
  assert.equal(fmtTime(0), '0:00.00');
  assert.equal(fmtTime(9.5), '0:09.50');
  assert.equal(fmtTime(112.34), '1:52.34');
  assert.equal(fmtTime(-4), '0:00.00');
});

test('fmtShort truncates to whole seconds', () => {
  assert.equal(fmtShort(0), '0:00');
  assert.equal(fmtShort(112.9), '1:52');
});

test('fmtHuman picks the biggest sensible unit', () => {
  assert.equal(fmtHuman(45), '45s');
  assert.equal(fmtHuman(34 * 60), '34m');
  assert.equal(fmtHuman(112 * 60), '1h 52m');
});

test('fmtSize switches from MB to GB at 1024 MB', () => {
  assert.equal(fmtSize(20 * 1024 * 1024), '20.0 MB');
  assert.equal(fmtSize(5 * 1024 * 1024 * 1024), '5.00 GB');
});

test('clamp bounds a value', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

test('niceStep always keeps labels at least 72px apart', () => {
  for (const zoom of [4, 10, 35, 90, 220]) {
    assert.ok(niceStep(zoom) * zoom >= 72, `zoom ${zoom} produced a crowded ruler`);
  }
});
