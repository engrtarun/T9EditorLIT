import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chunkSourceKey, jobWatchdog, toLineFlag } from './cloud-contract.ts';
import { NoSpeechError, runTranscription } from './pipeline.ts';
import type { AudioChunk } from './types.ts';

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

/**
 * Extract and cleanup must agree on the same subdirectory name or a source's
 * chunks would be created in one folder and wiped (or never wiped) in another.
 */
test('chunkSourceKey is deterministic, shaped for the filesystem and per-source', () => {
  const one = chunkSourceKey('D:\\videos\\one.mp4');
  assert.equal(chunkSourceKey('D:\\videos\\one.mp4'), one);
  // The Rust sanitizer passes `[0-9a-f]` through untouched, so this must stay
  // exactly that — 8 hex characters, no path syntax.
  assert.match(one, /^[0-9a-f]{8}$/);
  assert.notEqual(chunkSourceKey('D:\\videos\\two.mp4'), one);
});

/**
 * The daemon's no-speech contract. A music-only video used to reach the UI as
 * a generic "every chunk failed" error — a retry loop that could never
 * converge. Now a succeeded job with zero words throws `NoSpeechError`, and
 * that distinction is pinned here so it cannot quietly become "failed" again.
 */
const respond = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

const oneChunk = (): AudioChunk => ({
  index: 0,
  path: 'C:\\videos\\toon-c0.wav',
  offsetSecs: 0,
  durationSecs: 24
});

test('a done job with no_speech throws NoSpeechError, not a generic failure', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/v1/transcribe')) {
      return respond({ id: 'j1', kind: 'transcribe', state: 'queued', total: 1 });
    }
    if (url.includes('/v1/jobs/j1')) {
      // The daemon's answer: every chunk was read, no words anywhere.
      return respond({ id: 'j1', kind: 'transcribe', state: 'done', no_speech: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => runTranscription('D:\\videos\\toon.mp4', [oneChunk()]),
      NoSpeechError
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a partial job returns its words plus the failed chunk indices', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/v1/transcribe')) {
      return respond({ id: 'j3', kind: 'transcribe', state: 'queued', total: 2 });
    }
    if (url.includes('/v1/jobs/j3')) {
      // The daemon read chunk 0, could not read chunk 1, and said so.
      return respond({
        id: 'j3',
        kind: 'transcribe',
        state: 'partial',
        total: 2,
        error: 'chunk_001.wav: groq returned 400: unsupported language',
        failed_chunks: [1],
        transcript: [
          { id: '0-0', start_secs: 0, end_secs: 1, text: 'pehla hissa', flag: 'none', keep: true }
        ]
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const res = await runTranscription('D:\\videos\\long.mp4', [oneChunk(), oneChunk()]);
    // The words that worked are a result, not an error.
    assert.equal(res.segments.length, 1);
    // The hole is named, so the panel can offer a cheap retry of just this.
    assert.deepEqual(res.failedChunks, [1]);
    assert.match(res.error ?? '', /unsupported language/);
    assert.equal(res.noSpeech, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a genuinely failed job stays a plain Error', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/v1/transcribe')) {
      return respond({ id: 'j2', kind: 'transcribe', state: 'queued', total: 1 });
    }
    if (url.includes('/v1/jobs/j2')) {
      return respond({
        id: 'j2',
        kind: 'transcribe',
        state: 'failed',
        error: 'every chunk failed; first error: quota'
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const err = await runTranscription('D:\\videos\\broken.mp4', [oneChunk()]).catch(
      (e: unknown) => e
    );
    assert.ok(err instanceof Error && !(err instanceof NoSpeechError), JSON.stringify(err));
    assert.match((err as Error).message, /every chunk failed/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
