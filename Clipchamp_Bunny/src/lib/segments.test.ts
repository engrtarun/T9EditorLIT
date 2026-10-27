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
  sourceAt,
  timelineDuration
} from './segments.ts';
import type { TranscriptLine } from './types.ts';

let seq = 0;
function line(
  startSec: number,
  endSec: number,
  keep: 'keep' | 'cut' = 'keep',
  text = 'x',
  flag: TranscriptLine['flag'] = 'none'
): TranscriptLine {
  return {
    id: `ln-${seq++}`,
    startSec,
    endSec,
    text,
    flag,
    keep,
    confidence: 1
  };
}

test('buildSegments keeps a cut visible as its own segment', () => {
  seq = 0;
  const lines = [line(0, 2), line(2, 4), line(4, 6, 'cut'), line(6, 8)];
  const segs = buildSegments(lines);
  assert.equal(segs.length, 3, 'cut material becomes a clip instead of vanishing');
  assert.deepEqual([segs[0].startSec, segs[0].endSec], [0, 4]);
  assert.deepEqual([segs[1].startSec, segs[1].endSec], [4, 6]);
  assert.deepEqual([segs[2].startSec, segs[2].endSec], [6, 8]);
  assert.equal(segs[0].state, 'keep');
  assert.equal(segs[1].state, 'cut');
  assert.equal(segs[1].reason, 'user', 'a non-silence cut paints red');
  assert.equal(segs[2].state, 'keep');
  assert.equal(segs[0].lines.length, 2);
});

test('editDuration counts the final video, timelineDuration the whole strip', () => {
  seq = 0;
  const segs = buildSegments([line(0, 3), line(10, 15)]);
  assert.equal(editDuration(segs), 8, 'kept seconds only');
  assert.equal(timelineDuration(segs), 15, 'the red block still takes its width');
  const off = computeOffsets(segs);
  const [a, cut, b] = segs;
  assert.deepEqual(off.get(a.id), { start: 0, end: 3 });
  assert.deepEqual(off.get(cut.id), { start: 3, end: 10 });
  assert.deepEqual(off.get(b.id), { start: 10, end: 15 });
});

test('source time maps into timeline time and back', () => {
  seq = 0;
  const segs = buildSegments([line(10, 20), line(30, 40)]);
  const off = computeOffsets(segs);
  assert.equal(editTimeAt(segs, off, 12), 2);
  // A cut source time is not lost — it lives inside its own red block.
  assert.equal(editTimeAt(segs, off, 25), 15);
  // edit/timeline 5 s is 5 s into segment A, whose source starts at 10 s
  assert.equal(sourceAt(segs, off, 5), 15);
  // timeline 15 s is the middle of the cut block: source 20 + 5
  assert.equal(sourceAt(segs, off, 15), 25);
  assert.equal(sourceAt(segs, off, 99), null);
});

test('reordering segments reorders the transcript rows', () => {
  seq = 0;
  const lines = [line(0, 5, 'keep', 'first'), line(10, 15, 'keep', 'second')];
  const segs = buildSegments(lines);
  const keeps = segs.filter((s) => s.state === 'keep');
  assert.equal(keeps.length, 2);
  const order = orderSegments(segs, [keeps[1].id, keeps[0].id]);
  assert.equal(order[0].id, keeps[1].id);
  const rows = orderLines(order, lines);
  assert.deepEqual(
    rows.map((r) => r.text),
    ['second', 'first']
  );
});

test('segment ids stay stable when an earlier clip is removed', () => {
  seq = 0;
  const lines = [line(0, 2), line(2, 4), line(10, 12), line(20, 22)];
  const before = buildSegments(lines);
  const b = before.find((s) => s.startSec === 10)!;
  const after = buildSegments(lines.map((l) => (l.startSec === 0 ? { ...l, keep: 'cut' } : l)));
  assert.equal(after.find((s) => s.startSec === 10)?.id, b.id);
});

test('a cut line keeps its row next to the clip it interrupts', () => {
  seq = 0;
  const lines = [line(0, 5, 'keep', 'a'), line(5, 8, 'cut', 'gap'), line(8, 12, 'keep', 'b')];
  const segs = buildSegments(lines);
  const rows = orderLines(segs, lines);
  assert.deepEqual(
    rows.map((r) => r.text),
    ['a', 'gap', 'b']
  );
});

test('a silence-flagged cut paints grey, a fumble paints red', () => {
  seq = 0;
  const segs = buildSegments([
    line(0, 4, 'keep'),
    line(4, 9, 'cut', 'khamoshi', 'silence'),
    line(9, 12, 'cut', 'fumble')
  ]);
  assert.equal(segs[1].reason, 'silence');
  assert.equal(segs[2].reason, 'user');
});

test('dead air the transcript never covered shows up as grey silence', () => {
  seq = 0;
  const segs = buildSegments([line(0, 4), line(20, 24)]);
  assert.deepEqual(
    segs.map((s) => [s.startSec, s.endSec, s.state, s.reason]),
    [
      [0, 4, 'keep', undefined],
      [4, 20, 'cut', 'silence'],
      [20, 24, 'keep', undefined]
    ]
  );
  assert.equal(editDuration(segs), 8);
  assert.equal(timelineDuration(segs), 24);
});

test('a hairline pause between two kept lines stays part of the clip', () => {
  seq = 0;
  const segs = buildSegments([line(0, 4), line(4.2, 8)]);
  assert.equal(segs.length, 1, 'a 0.2 s pause is not a clip of its own');
  assert.deepEqual([segs[0].startSec, segs[0].endSec], [0, 8]);
});

test('without a transcript the source is one clip, cut spans carve it up', () => {
  seq = 0;
  const whole = buildSegments([], { sourceDurationSec: 60 });
  assert.equal(whole.length, 1);
  assert.equal(whole[0].state, 'keep');
  assert.deepEqual([whole[0].startSec, whole[0].endSec], [0, 60]);

  const cut = buildSegments([], { sourceDurationSec: 60, cutSpans: [[20, 30]] });
  assert.deepEqual(
    cut.map((s) => [s.startSec, s.endSec, s.state, s.reason]),
    [
      [0, 20, 'keep', undefined],
      [20, 30, 'cut', 'user'],
      [30, 60, 'keep', undefined]
    ]
  );
  assert.equal(editDuration(cut), 50);
  assert.equal(timelineDuration(cut), 60);
});

test('a split with no transcript under the playhead still cuts the clip in two', () => {
  seq = 0;
  const segs = buildSegments([], { sourceDurationSec: 40, splitMarks: [15] });
  assert.equal(segs.length, 2);
  assert.deepEqual([segs[0].startSec, segs[0].endSec], [0, 15]);
  assert.deepEqual([segs[1].startSec, segs[1].endSec], [15, 40]);
});

test('a transcript-less cut stays red after the transcript arrives', () => {
  seq = 0;
  const spans: Array<[number, number]> = [[10, 20]];
  // before: no lines at all
  const bare = buildSegments([], { sourceDurationSec: 40, cutSpans: spans });
  assert.equal(bare[1].reason, 'user');
  // after: the transcript covers everything except the cut — the cut must not
  // silently become "kept" just because a line now claims that stretch
  const withLines = buildSegments([line(0, 10), line(20, 40)], {
    sourceDurationSec: 40,
    cutSpans: spans
  });
  assert.deepEqual(
    withLines.map((s) => [s.startSec, s.endSec, s.state]),
    [
      [0, 10, 'keep'],
      [10, 20, 'cut'],
      [20, 40, 'keep']
    ]
  );
});

test('restoring a cut row restores the clip', () => {
  seq = 0;
  const cut = [line(0, 4), line(4, 9, 'cut'), line(9, 12)];
  const cutSegs = buildSegments(cut);
  assert.equal(cutSegs[1].state, 'cut');
  const restored = buildSegments(cut.map((l) => ({ ...l, keep: 'keep' as const })));
  assert.equal(restored.length, 1, 'the three runs glue back into one clip');
  assert.equal(restored[0].state, 'keep');
  assert.equal(editDuration(restored), 12);
});

test('dropIndex picks the segment whose midpoint the pointer passed', () => {
  seq = 0;
  // gaps so the three lines stay three separate clips (the gaps become grey
  // blocks of their own between them)
  const segs = buildSegments([line(0, 10), line(12, 22), line(24, 34)]);
  assert.equal(segs.length, 5);
  const off = computeOffsets(segs);
  // timeline: keep 0-10 · cut 10-12 · keep 12-22 · cut 22-24 · keep 24-34
  assert.equal(dropIndex(segs, off, segs[0].id, 5), 0, 'before the first midpoint');
  assert.equal(dropIndex(segs, off, segs[0].id, 11.5), 1, 'inside the grey block');
  assert.equal(dropIndex(segs, off, segs[0].id, 30), 4, 'past the last midpoint');
});

test('moveInOrder splices into the reduced list', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(moveInOrder(order, 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(moveInOrder(order, 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(moveInOrder(order, 'b', 1), ['a', 'b', 'c']);
});
