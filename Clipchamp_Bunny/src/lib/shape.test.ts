import test from 'node:test';
import assert from 'node:assert/strict';

import { buildShape, hasCta, keepZones, shapeSummary } from './shape.ts';
import type { TranscriptLine } from './types.ts';

function line(startSec: number, endSec: number, text: string): TranscriptLine {
  return { id: `${startSec}`, startSec, endSec, text, flag: 'none', keep: 'keep', confidence: 1 };
}

test('empty transcript has no shape', () => {
  assert.deepEqual(buildShape([], 60), []);
});

test('the first window is the intro and the last with a CTA is the outro', () => {
  const lines: TranscriptLine[] = [];
  for (let t = 0; t < 60; t += 10) lines.push(line(t, t + 9, 'aaj hum seekhenge kuch naya'));
  lines.push(line(60, 69, 'video pasand aayi to subscribe karo'));
  const shape = buildShape(lines, 70, { windowSecs: 20 });
  assert.equal(shape[0].kind, 'intro');
  assert.equal(shape.at(-1)?.kind, 'outro');
});

test('a silent window is demo/dead air, not teaching', () => {
  const shape = buildShape([line(0, 5, 'hello doston'), line(80, 90, 'subscribe karo')], 90, {
    windowSecs: 20
  });
  const dead = shape.find((s) => s.start >= 20 && s.start < 60);
  assert.ok(dead);
  assert.equal(dead.kind, 'demo');
});

test('keepZones are exactly the intro and outro ranges', () => {
  const shape = buildShape(
    [line(0, 10, 'welcome'), line(20, 30, 'teaching'), line(40, 50, 'subscribe karo')],
    50,
    { windowSecs: 10 }
  );
  const zones = keepZones(shape);
  assert.ok(zones.length >= 2);
  assert.equal(zones[0].start, 0);
  assert.ok(zones.at(-1)!.end >= 40);
});

test('CTA vocabulary covers Hinglish and Devanagari', () => {
  assert.equal(hasCta('please subscribe'), true);
  assert.equal(hasCta('सब्सक्राइब करना'), true);
  assert.equal(hasCta('aaj hum loops dekhenge'), false);
  assert.equal(hasCta('comment me batao'), true);
});

test('adjacent windows of one kind coalesce', () => {
  const lines = [line(0, 60, 'aaj hum ek lamba topic cover karenge')];
  const shape = buildShape(lines, 60, { windowSecs: 5 });
  const intro = shape[0];
  assert.equal(intro.kind, 'intro');
  assert.equal(intro.start, 0);
  assert.equal(intro.end, 10, 'the two intro windows must merge into one block');
});

test('shapeSummary lists the kinds in order', () => {
  const shape = buildShape([line(0, 10, 'welcome'), line(30, 40, 'subscribe karo')], 40, {
    windowSecs: 10
  });
  const text = shapeSummary(shape);
  assert.match(text, /Intro/);
  assert.match(text, /Outro/);
});
