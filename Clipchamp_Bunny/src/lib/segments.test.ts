import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSegments,
  computeOffsets,
  dropIndex,
  editDuration,
  editTimeAt,
  moveInOrder,
  orderLines,
  orderSegments,
  sourceAt
} from './segments.ts';
import type { TranscriptLine } from './types.ts';

let seq = 0;
function line(
  startSec: number,
  endSec: number,
  keep: 'keep' | 'cut' = 'keep',
  text = 'x'
): TranscriptLine {
  return {
    id: `ln-${seq++}`,
    startSec,
    endSec,
    text,
    flag: 'none',
    keep,
    confidence: 1
  };
}

test('buildSegments groups contiguous kept lines and splits on a cut', () => {
  seq = 0;
  const lines = [line(0, 2), line(2, 4), line(4, 6, 'cut'), line(6, 8)];
  const segs = buildSegments(lines);
  assert.equal(segs.length, 2);
  assert.deepEqual([segs[0].startSec, segs[0].endSec], [0, 4]);
  assert.deepEqual([segs[1].startSec, segs[1].endSec], [6, 8]);
  assert.equal(segs[0].lines.length, 2);
});

test('editDuration and offsets describe the final video', () => {
  seq = 0;
  const segs = buildSegments([line(0, 3), line(10, 15)]);
  assert.equal(editDuration(segs), 8);
  const off = computeOffsets(segs);
  assert.deepEqual(off.get(segs[0].id), { start: 0, end: 3 });
  assert.deepEqual(off.get(segs[1].id), { start: 3, end: 8 });
});

test('source time maps into edit time and back', () => {
  seq = 0;
  const segs = buildSegments([line(10, 20), line(30, 40)]);
  const off = computeOffsets(segs);
  assert.equal(editTimeAt(segs, off, 12), 2);
  assert.equal(editTimeAt(segs, off, 25), null, 'a cut source time has no edit position');
  // edit 5 s is 5 s into segment A, whose source starts at 10 s
  assert.equal(sourceAt(segs, off, 5), 15);
  // edit 15 s is 5 s into segment B, whose source starts at 30 s
  assert.equal(sourceAt(segs, off, 15), 35);
  assert.equal(sourceAt(segs, off, 99), null);
});

test('reordering segments reorders the transcript rows', () => {
  seq = 0;
  const lines = [line(0, 5, 'keep', 'first'), line(10, 15, 'keep', 'second')];
  const segs = buildSegments(lines);
  const order = orderSegments(segs, [segs[1].id, segs[0].id]);
  assert.equal(order[0].id, segs[1].id);
  const rows = orderLines(order, lines);
  assert.deepEqual(
    rows.map((r) => r.text),
    ['second', 'first']
  );
});

test('a cut line is attached to the segment it interrupts', () => {
  seq = 0;
  const lines = [line(0, 5, 'keep', 'a'), line(5, 8, 'cut', 'gap'), line(8, 12, 'keep', 'b')];
  const segs = buildSegments(lines);
  const rows = orderLines(segs, lines);
  assert.deepEqual(
    rows.map((r) => r.text),
    ['a', 'gap', 'b']
  );
});

test('dropIndex picks the segment whose midpoint the pointer passed', () => {
  seq = 0;
  // gaps so the three lines stay three separate segments
  const segs = buildSegments([line(0, 10), line(12, 22), line(24, 34)]);
  assert.equal(segs.length, 3);
  const off = computeOffsets(segs);
  // edit axis: A 0-10, B 10-20, C 20-30
  // drop past B's midpoint (15) → lands after B → index 1
  assert.equal(dropIndex(segs, off, segs[0].id, 18), 1);
  // drop past C's midpoint (25) → index 2 (the end)
  assert.equal(dropIndex(segs, off, segs[0].id, 26), 2);
  // drop before A's midpoint (5) → index 0
  assert.equal(dropIndex(segs, off, segs[2].id, 1), 0);
});

test('moveInOrder splices into the reduced list', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(moveInOrder(order, 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(moveInOrder(order, 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(moveInOrder(order, 'b', 1), ['a', 'b', 'c']);
});
