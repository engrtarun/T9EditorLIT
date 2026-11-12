import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_BATCH_FILES,
  batchHasWork,
  batchName,
  batchPosition,
  batchProgress,
  batchTotals,
  makeBatchItem,
  nextQueued,
  parseBatchQueue,
  serializeBatchQueue,
  type BatchItem
} from './batch-queue.ts';

/**
 * The batch queue's arithmetic is what the user reads before spending money:
 * "3/30", the cost line, and which file starts next. Those four answers must
 * not drift from the rows on screen, so they are pinned here.
 */

/** A row that behaves like a probed, queued file. */
const item = (id: string, over: Partial<BatchItem> = {}): BatchItem => ({
  ...makeBatchItem(`D:\\notes\\${id}.m4a`, id),
  status: 'queued',
  durationSecs: 300,
  ...over
});

test('a file name loses the folder and the extension, nothing else', () => {
  assert.equal(batchName('D:\\voice\\note 3.m4a'), 'note 3');
  assert.equal(batchName('/home/t9/take.final.wav'), 'take.final');
  assert.equal(batchName('no-extension'), 'no-extension');
});

test('a fresh row is selected, unpriced and waiting for its probe', () => {
  const row = makeBatchItem('D:\\voice\\a.m4a', 'a');
  assert.equal(row.status, 'probing');
  assert.equal(row.selected, true);
  assert.equal(row.durationSecs, 0);
  assert.equal(row.totalChunks, 0);
});

test('the queue survives a round trip through storage', () => {
  const rows = [item('a'), item('b', { status: 'done', lines: 42 })];
  const back = parseBatchQueue(serializeBatchQueue(rows));
  // Compare the persisted form, not object identity: `parseBatchQueue`
  // normalises `error` to an explicit `undefined`.
  assert.equal(serializeBatchQueue(back), serializeBatchQueue(rows));
});

test('a row left "running" by a dead process comes back as queued', () => {
  // The process that owned `running` no longer exists; resuming it as
  // `running` would make the worker skip the file forever.
  const back = parseBatchQueue(
    JSON.stringify({ items: [{ path: 'D:\\a.m4a', id: 'a', status: 'running' }] })
  );
  assert.equal(back[0].status, 'queued');
});

test('hostile storage cannot create rows the worker would trust', () => {
  assert.deepEqual(parseBatchQueue(null), []);
  assert.deepEqual(parseBatchQueue('{not json'), []);
  assert.deepEqual(parseBatchQueue(JSON.stringify({ items: 'nope' })), []);
  const rows = parseBatchQueue(
    JSON.stringify({
      items: [
        { path: 'D:\\a.m4a', status: 'exploded', durationSecs: -5, selected: false },
        { path: '', status: 'queued' },
        { path: 'D:\\a.m4a', status: 'queued' }
      ]
    })
  );
  // Bad status -> queued, bad duration -> 0, duplicate path -> one row.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'queued');
  assert.equal(rows[0].durationSecs, 0);
  assert.equal(rows[0].selected, false);
});

test('the queue is capped instead of growing without bound', () => {
  const many = Array.from({ length: MAX_BATCH_FILES + 5 }, (_, i) => ({
    path: `D:\\notes\\${i}.m4a`,
    id: `i${i}`,
    status: 'queued'
  }));
  assert.equal(parseBatchQueue(JSON.stringify({ items: many })).length, MAX_BATCH_FILES);
});

test('the cost line only prices rows that will actually run', () => {
  const totals = batchTotals([
    item('a', { durationSecs: 600 }), // 2 calls
    item('b', { durationSecs: 300 }), // 1 call
    item('c', { selected: false }), // unticked
    item('d', { status: 'done' }), // already paid for
    item('e', { status: 'cached' }) // already on disk
  ]);
  assert.equal(totals.files, 2);
  assert.equal(totals.calls, 3);
  assert.equal(totals.audioSecs, 900);
  assert.ok(totals.etaSecs >= 20);
});

test('a row with no probed duration is priced at zero, not NaN', () => {
  const totals = batchTotals([item('a', { durationSecs: 0 })]);
  assert.deepEqual(totals, { files: 1, calls: 0, audioSecs: 0, etaSecs: 0 });
});

test('the worker takes the first selected queued row, in list order', () => {
  const rows = [
    item('a', { status: 'done' }),
    item('b', { selected: false }),
    item('c'),
    item('d')
  ];
  assert.equal(nextQueued(rows)?.id, 'c');
  assert.equal(nextQueued(rows.map((r) => item(r.id, { status: 'failed' }))), null);
});

test('"3/30" counts the ticked rows in the order the user picked them', () => {
  const rows = [item('a'), item('b', { selected: false }), item('c')];
  assert.deepEqual(batchPosition(rows, 'a'), { at: 1, of: 2 });
  assert.deepEqual(batchPosition(rows, 'c'), { at: 2, of: 2 });
  assert.equal(batchPosition(rows, 'b'), null);
});

test('progress counts done and cached as finished, out of the ticked total', () => {
  const rows = [
    item('a', { status: 'done' }),
    item('b', { status: 'cached' }),
    item('c', { status: 'failed' }),
    item('d', { selected: false })
  ];
  assert.deepEqual(batchProgress(rows), { done: 2, total: 3 });
  assert.equal(batchHasWork(rows), false);
  assert.equal(batchHasWork([...rows, item('e')]), true);
});
