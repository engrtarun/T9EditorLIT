import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  estimateForDuration,
  estimatePlan,
  isOfflineError,
  isPlanComplete,
  markDone,
  nextSpan,
  parsePlan,
  pendingSecs,
  planFromChunks,
  reconcileBoundary,
  spansInRange,
  type TranscriptPlan
} from './transcript-plan.ts';
import type { AudioChunk, TranscriptLine } from './types.ts';

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

test('a time range buys only the chunks that touch it', () => {
  const plan = planFromChunks([chunk(0, 0), chunk(1, 300), chunk(2, 600), chunk(3, 900)]);

  // 14:00-16:00 with 5-minute chunks straddles chunk 2 (600-900) and chunk 3
  // (900-1200). Chunk 1 (300-600) is behind the range and must not be bought.
  assert.deepEqual(
    spansInRange(plan, 840, 960).map((s) => s.index),
    [2, 3]
  );
  // 12:00-14:00 sits inside chunk 2 alone; the chunk that starts at 15:00 is
  // outside it.
  assert.deepEqual(
    spansInRange(plan, 720, 840).map((s) => s.index),
    [2]
  );
  // The boundary is half-open: a range that starts where chunk 2 starts does
  // not also re-buy the chunk that ends there.
  assert.deepEqual(
    spansInRange(plan, 600, 601).map((s) => s.index),
    [2]
  );
  // A chunk already in SQLite is never bought twice.
  assert.deepEqual(
    spansInRange(markDone(plan, 2), 600, 601).map((s) => s.index),
    []
  );
  // Reversed inputs are the same range, not an empty one.
  assert.deepEqual(
    spansInRange(plan, 960, 840).map((s) => s.index),
    [2, 3]
  );
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

/* ── Case 9: chunk-boundary reconciliation ──────────────────────────────── */

const line = (id: string, startSec: number, endSec: number, text: string): TranscriptLine => ({
  id,
  startSec,
  endSec,
  text,
  flag: 'none',
  keep: 'keep',
  confidence: 1
});

test('the same sentence heard by both sides of a cut becomes one line', () => {
  const previous = [line('a', 298, 301, 'we need to')];
  const next = [line('b', 298.2, 302, 'we need to')];
  const merged = reconcileBoundary(previous, next);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'a');
});

test('the side that heard the whole word wins', () => {
  const previous = [line('a', 298, 301, 'we need to deci')];
  const next = [line('b', 298.2, 302, 'we need to decide')];
  const merged = reconcileBoundary(previous, next);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'we need to decide');
  // The user's keep/cut decision survives the text upgrade.
  assert.equal(merged[0].keep, 'keep');
});

test('two different sentences in the overlap are both kept', () => {
  // A duplicate is cheap to cut; a missing word is not recoverable.
  const previous = [line('a', 298, 301, 'subscribe kar lo')];
  const next = [line('b', 298.2, 302, 'video achha laga')];
  const merged = reconcileBoundary(previous, next);
  assert.equal(merged.length, 2);
});

test('a line after the overlap is simply appended in order', () => {
  const previous = [line('a', 298, 301, 'we need to')];
  const next = [line('b', 298.2, 302, 'we need to decide'), line('c', 305, 308, 'next sentence')];
  const merged = reconcileBoundary(previous, next);
  assert.deepEqual(
    merged.map((l) => l.id),
    ['a', 'c']
  );
  assert.equal(merged[0].text, 'we need to decide');
});

test('a resumed plan that finishes a later chunk still reads in source order', () => {
  // Chunk 1 was finished earlier and sits after chunk 0's boundary.
  const previous = [line('a', 0, 5, 'pehla'), line('z', 600, 605, 'baad wala')];
  const next = [line('b', 4.8, 9, 'doosra')];
  const merged = reconcileBoundary(previous, next);
  assert.deepEqual(
    merged.map((l) => l.text),
    ['pehla', 'doosra', 'baad wala']
  );
});

test('"offline" needs connection evidence, not just any failure', () => {
  assert.equal(isOfflineError('Failed to fetch'), true);
  assert.equal(isOfflineError('connect ECONNREFUSED 127.0.0.1:7878'), true);
  assert.equal(isOfflineError('network error while polling job'), true);
  assert.equal(isOfflineError('getaddrinfo ENOTFOUND api.groq.com'), true);
  // The daemon answered, so the network is fine: these keep their own words.
  assert.equal(isOfflineError('/v1/transcribe → 429 rate limit'), false);
  assert.equal(isOfflineError('job 3 → 503 daemon busy'), false);
  assert.equal(isOfflineError('audio chunk 25 MB se bada hai'), false);
  assert.equal(isOfflineError('koi speech nahi mili'), false);
  assert.equal(isOfflineError(null), false);
  assert.equal(isOfflineError(''), false);
});
