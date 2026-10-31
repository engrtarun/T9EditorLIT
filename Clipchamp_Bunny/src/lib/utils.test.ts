import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clamp, fmtHuman, fmtShort, fmtSize, fmtTime, niceStep, parseTimecode } from './utils.ts';

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

test('parseTimecode reads the forms a person actually types', () => {
  assert.equal(parseTimecode('83'), 83);
  assert.equal(parseTimecode('1:23'), 83);
  assert.equal(parseTimecode('1:23.45'), 83.45);
  assert.equal(parseTimecode('0:05.63'), 5.63);
  assert.equal(parseTimecode('1:02:03'), 3723);
  assert.equal(parseTimecode('1:02:03.5'), 3723.5);
});

test('parseTimecode tolerates spaces, commas and a leading zero', () => {
  assert.equal(parseTimecode('  1:23  '), 83);
  assert.equal(parseTimecode('1,5'), 1.5);
  assert.equal(parseTimecode('0:09'), 9);
});

test('parseTimecode refuses what it cannot know for sure', () => {
  for (const bad of ['', '   ', 'abc', '1:2:3:4', '1::2', '-5', '1:2:3.4.5', '1:23f']) {
    assert.equal(parseTimecode(bad), null, `"${bad}" should not parse`);
  }
});

test('niceStep always keeps labels at least 72px apart', () => {
  for (const zoom of [4, 10, 35, 90, 220]) {
    assert.ok(niceStep(zoom) * zoom >= 72, `zoom ${zoom} produced a crowded ruler`);
  }
});
