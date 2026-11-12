import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  estimateForDuration,
  estimatePlan,
  isPlanComplete,
  markDone,
  nextSpan,
  parsePlan,
  pendingSecs,
  planFromChunks,
  type TranscriptPlan
} from './transcript-plan.ts';
import type { AudioChunk } from './types.ts';

const chunk = (index: number, offsetSecs: number, durationSecs = 300): AudioChunk => ({
  index,
  path: `C:\\tmp\\chunk_${index}.wav`,
  offsetSecs,
  durationSecs
});

test('a plan turns chunk offsets into source spans', () => {
  const plan = planFromChunks([chunk(0, 0), chunk(1, 300), chunk(2, 600, 120)]);
  assert.deepEqual(plan.spans, [
    { index: 0, startSec: 0, endSec: 300 },
    { index: 1, startSec: 300, endSec: 600 },
    { index: 2, startSec: 600, endSec: 720 }
  ]);
  assert.deepEqual(plan.done, []);
});

test('marking a chunk done is idempotent and stays in order', () => {
  const plan = planFromChunks([chunk(0, 0), chunk(1, 300), chunk(2, 600)]);
  const one = markDone(plan, 2);
  const two = markDone(one, 0);
  const again = markDone(two, 2);
  assert.deepEqual(again.done, [0, 2]);
  // Same object back means the caller can skip a redundant write.
  assert.equal(again, two);
});

test('the next click is the first chunk that is not on disk yet', () => {
  const plan = markDone(planFromChunks([chunk(0, 0), chunk(1, 300), chunk(2, 600)]), 0);
  assert.equal(nextSpan(plan)?.index, 1);
});

test('a silent chunk counts as done — re-sending silence buys nothing', () => {
  const plan = markDone(planFromChunks([chunk(0, 0)]), 0);
  assert.equal(nextSpan(plan), null);
  assert.equal(isPlanComplete(plan), true);
});

test('the estimate only prices the audio that is still pending', () => {
  let plan = planFromChunks([chunk(0, 0), chunk(1, 300), chunk(2, 600, 180)]);
  assert.equal(pendingSecs(plan), 780);
  assert.equal(estimatePlan(plan).calls, 3);

  plan = markDone(plan, 0);
  assert.equal(pendingSecs(plan), 480);
  const est = estimatePlan(plan);
  assert.equal(est.calls, 2);
  assert.equal(est.audioSecs, 480);
  // 480 s * 0.2 = 96 s of expected wait.
  assert.equal(est.etaSecs, 96);

  plan = markDone(markDone(plan, 1), 2);
  assert.deepEqual(estimatePlan(plan), { audioSecs: 0, calls: 0, etaSecs: 0 });
});

test('a short remainder still gets a realistic floor, not 0 seconds', () => {
  const plan = planFromChunks([chunk(0, 0, 20)]);
  assert.equal(estimatePlan(plan).etaSecs, 20);
});

test('a stored plan is trusted only after its shape is checked', () => {
  assert.equal(parsePlan(null), null);
  assert.equal(parsePlan('{}'), null);
  assert.equal(parsePlan({ spans: [] }), null);

  // Junk spans are dropped, the valid ones survive, and unknown "done"
  // indices cannot make the panel claim work that no chunk backs.
  const plan = parsePlan({
    spans: [
      { index: 1, startSec: 300, endSec: 600 },
      { index: 0, startSec: 0, endSec: 300 },
      { index: 'x', startSec: 0, endSec: 1 },
      { index: 2, startSec: 'nope', endSec: 900 }
    ],
    done: [1, 9, 'two']
  }) as TranscriptPlan;

  assert.deepEqual(
    plan.spans.map((s) => s.index),
    [0, 1]
  );
  assert.deepEqual(plan.done, [1]);
});

test('the pre-click estimate mirrors the 300 s splitter, before any audio is touched', () => {
  // 49:50 → ten chunks, the whole file is what a first click would cover.
  const est = estimateForDuration(2990);
  assert.equal(est.calls, 10);
  assert.equal(est.audioSecs, 2990);
  assert.equal(est.etaSecs, 598);

  // A 20 s clip is one call with the realistic floor.
  assert.deepEqual(estimateForDuration(20), { audioSecs: 20, calls: 1, etaSecs: 20 });

  // Nothing to estimate is not a fake promise.
  assert.deepEqual(estimateForDuration(0), { audioSecs: 0, calls: 0, etaSecs: 0 });

  // A custom segment size is honoured, and a nonsense one falls back.
  assert.equal(estimateForDuration(900, 60).calls, 15);
  assert.equal(estimateForDuration(900, 0).calls, 3);
});
