import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyGaps,
  cutCandidates,
  gapStats,
  gapSummary,
  subtractKeepZones
} from './silence-map.ts';

test('classifyGaps tiers a raw detector map', () => {
  const gaps = classifyGaps([
    { start: 0, end: 0.6 },
    { start: 10, end: 13 },
    { start: 20, end: 30 },
    { start: 40, end: 40 } // invalid, dropped
  ]);
  assert.equal(gaps.length, 3);
  assert.deepEqual(
    gaps.map((g) => g.tier),
    ['micro', 'medium', 'big']
  );
  assert.equal(gaps[2].duration, 10);
});

test('a reverb tail merges when no line covers the bridge', () => {
  const gaps = classifyGaps(
    [
      { start: 10, end: 12 },
      { start: 12.4, end: 14 }
    ],
    {
      lines: [
        { startSec: 8, endSec: 10 },
        { startSec: 14.5, endSec: 16 }
      ]
    }
  );
  assert.equal(gaps.length, 1, 'the 0.4 s strip is part of the same tail');
  assert.equal(gaps[0].start, 10);
  assert.equal(gaps[0].end, 14);
});

test('a merge never swallows a short real word', () => {
  const gaps = classifyGaps(
    [
      { start: 10, end: 12 },
      { start: 12.4, end: 14 }
    ],
    { lines: [{ startSec: 12.1, endSec: 12.35 }] }
  );
  assert.equal(gaps.length, 2, 'a spoken line in the bridge keeps the spans apart');
});

test('cutCandidates offers big gaps only by default', () => {
  const gaps = classifyGaps([
    { start: 0, end: 0.6 },
    { start: 10, end: 13 },
    { start: 20, end: 30 }
  ]);
  assert.deepEqual(cutCandidates(gaps), [{ start: 20, end: 30 }]);
  assert.equal(cutCandidates(gaps, { includeMedium: true }).length, 2);
});

test('subtractKeepZones protects the intro and the CTA', () => {
  const out = subtractKeepZones(
    [
      { start: 0, end: 12 },
      { start: 40, end: 60 }
    ],
    [
      { start: 0, end: 5 },
      { start: 50, end: 55 }
    ]
  );
  assert.deepEqual(out, [
    { start: 5, end: 12 },
    { start: 40, end: 50 },
    { start: 55, end: 60 }
  ]);
});

test('a cut fully inside a keep-zone disappears', () => {
  const out = subtractKeepZones([{ start: 2, end: 4 }], [{ start: 0, end: 5 }]);
  assert.deepEqual(out, []);
});

test('gapStats reports honest seconds per tier', () => {
  const stats = gapStats(
    classifyGaps([
      { start: 0, end: 1 },
      { start: 5, end: 9 },
      { start: 15, end: 25 },
      { start: 30, end: 41 }
    ])
  );
  assert.equal(stats.micro, 1);
  assert.equal(stats.medium, 1);
  assert.equal(stats.big, 2);
  assert.equal(stats.bigSecs, 21);
  assert.equal(stats.cuttableSecs, 21);
  assert.equal(stats.longestSecs, 11);
});

test('gapSummary names the tiers in Hinglish', () => {
  const stats = gapStats([
    { start: 0, end: 1, duration: 1, tier: 'micro' },
    { start: 5, end: 9, duration: 4, tier: 'medium' },
    { start: 15, end: 45, duration: 30, tier: 'big' }
  ]);
  const text = gapSummary(stats);
  assert.match(text, /1 bade gaps = 0:30/);
  assert.match(text, /1 medium/);
  assert.match(text, /1 micro/);
});
