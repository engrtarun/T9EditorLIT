import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapPlanToAudio, snapToGap } from './wave-snap.ts';
import { planWordCut } from './word-cut.ts';
import { fmtMs } from './utils.ts';
import type { TranscriptLine, WaveformData } from './types.ts';

/** 100 buckets over 10 s — 100 ms each, close to the real ~50 ms fixture. */
function wave(peaks: number[], durationSecs = 10): WaveformData {
  return { durationSecs, bars: peaks.length, peaks, cachePath: null };
}

function flat(level = 0.7, length = 100): number[] {
  return Array.from({ length }, () => level);
}

/** A speech profile with a quiet valley around `bucket`. */
function withValley(bucket: number, level = 0.01): number[] {
  const peaks = flat();
  peaks[bucket - 2] = 0.55;
  peaks[bucket - 1] = 0.12;
  peaks[bucket] = level;
  peaks[bucket + 1] = 0.1;
  peaks[bucket + 2] = 0.5;
  return peaks;
}

function machli(): TranscriptLine {
  return {
    id: 'l1',
    text: 'machli jal ki rani h',
    startSec: 0,
    endSec: 4,
    flag: 'none',
    keep: 'keep',
    confidence: 1
  };
}

test('a boundary lands on the quiet gap, not the character-count guess', () => {
  const snap = snapToGap(wave(withValley(15)), 1.42, { windowSec: 0.4 });
  assert.equal(snap.snapped, true);
  // Bucket 15 spans 1.5–1.6 s; the parabola bottoms out just inside it.
  assert.ok(snap.sec > 1.5 && snap.sec < 1.62, `got ${snap.sec}`);
  assert.ok(snap.quiet < 0.02);
});

test('continuous speech is left alone — no fake pause', () => {
  const snap = snapToGap(wave(flat(0.9)), 1.42, { windowSec: 0.4 });
  assert.equal(snap.snapped, false);
  assert.equal(snap.sec, 1.42);
});

test('no waveform means no snap, and no crash', () => {
  assert.equal(snapToGap(null, 1.42).sec, 1.42);
  assert.equal(snapToGap(null, 1.42).snapped, false);
});

test('the plan welds the prefix and suffix to the snapped edges', () => {
  const peaks = withValley(15);
  const second = withValley(38);
  for (let i = 34; i <= 42; i++) peaks[i] = second[i];
  const plan = planWordCut(machli(), 7, 18);
  assert.ok(plan);
  const before = plan.toSec - plan.fromSec;

  const snapped = snapPlanToAudio(plan, wave(peaks), 0, 4);
  assert.equal(snapped.snapped, true);
  assert.ok(snapped.fromSec !== plan.fromSec);
  assert.ok(snapped.toSec !== plan.toSec);
  assert.equal(snapped.prefix?.toSec, snapped.fromSec);
  assert.equal(snapped.suffix?.fromSec, snapped.toSec);
  assert.equal(snapped.cut.fromSec, snapped.fromSec);
  assert.equal(snapped.cut.toSec, snapped.toSec);
  assert.ok(snapped.toSec - snapped.fromSec > before * 0.9);
});

test('a valley that swallows both edges never makes a zero-length cut', () => {
  const peaks = flat();
  peaks[18] = 0.3;
  peaks[19] = 0.01;
  peaks[20] = 0.3;
  const plan = planWordCut(machli(), 7, 10); // "jal": 1.5 s → 2.25 s
  assert.ok(plan);
  const snapped = snapPlanToAudio(plan, wave(peaks), 0, 4);
  assert.equal(snapped.snapped, false);
  assert.equal(snapped.fromSec, plan.fromSec);
  assert.equal(snapped.toSec, plan.toSec);
});

test('the plan is untouched without a waveform', () => {
  const plan = planWordCut(machli(), 7, 18);
  assert.ok(plan);
  assert.equal(snapPlanToAudio(plan, null, 0, 4), plan);
});

test('milliseconds are printed, not rounded to centiseconds', () => {
  assert.equal(fmtMs(1.486), '0:01.486');
  assert.equal(fmtMs(0), '0:00.000');
  assert.equal(fmtMs(61.0004), '1:01.000');
});
