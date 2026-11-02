import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jobWatchdog, toLineFlag } from './cloud-contract.ts';

/**
 * The old `waitJob` gave up after a fixed 600 × 900 ms — nine minutes — no
 * matter what the job was doing. Long videos died there, and the panel showed
 * "job timed out" for a run that was still healthy. These tests pin the two
 * real failure modes apart from "slow".
 */

const MIN = 60_000;

test('a slow job that keeps updating is never called stuck', () => {
  const started = 0;
  // 90 minutes in, but the daemon wrote to the job 30 seconds ago.
  assert.equal(jobWatchdog(90 * MIN, started, 90 * MIN - 30_000), null);
});

test('silence for longer than the stall window is a stall', () => {
  const started = 0;
  const lastChange = 10 * MIN;
  assert.equal(jobWatchdog(lastChange + 5 * MIN + 1, started, lastChange), 'stalled');
});

test('a stall is not reported one millisecond early', () => {
  const started = 0;
  const lastChange = 10 * MIN;
  assert.equal(jobWatchdog(lastChange + 5 * MIN, started, lastChange), null);
});

test('a job that updates forever still hits the overall ceiling', () => {
  const started = 0;
  const now = 121 * MIN;
  // It updated a moment ago — alive, but past the two-hour cap.
  assert.equal(jobWatchdog(now, started, now - 1_000), 'expired');
});

test('the flag vocabulary maps to the editor’s own names', () => {
  assert.equal(toLineFlag('fumble'), 'fumble');
  assert.equal(toLineFlag('retake'), 'repeat');
  assert.equal(toLineFlag('wrong_example'), 'wrong-example');
  assert.equal(toLineFlag('silence'), 'silence');
  // Anything the analyser invents later must not blank a line's state.
  assert.equal(toLineFlag('something-new'), 'none');
});
