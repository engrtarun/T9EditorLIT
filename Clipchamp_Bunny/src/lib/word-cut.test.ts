import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planWordCut, tokenizeLine } from './word-cut.ts';
import { wordCount } from './word-selection.ts';
import type { TranscriptLine } from './types.ts';

/** The user's own example: "machli jal ki rani h". */
function machli(): TranscriptLine {
  return {
    id: 'l1',
    startSec: 10,
    endSec: 12,
    text: 'machli jal ki rani h',
    flag: 'none',
    keep: 'keep',
    confidence: 1,
    words: [
      { word: 'machli', start: 10, end: 10.6 },
      { word: 'jal', start: 10.65, end: 10.95 },
      { word: 'ki', start: 10.95, end: 11.2 },
      { word: 'rani', start: 11.2, end: 11.8 },
      { word: 'h', start: 11.85, end: 12 }
    ]
  };
}

test('selecting the middle words cuts exactly them, in three parts', () => {
  const plan = planWordCut(machli(), 7, 18);
  assert.ok(plan);
  assert.equal(plan.whole, false);
  assert.equal(plan.approx, false);
  assert.equal(plan.cut.text, 'jal ki rani');
  assert.equal(plan.prefix?.text, 'machli');
  assert.equal(plan.suffix?.text, 'h');
  assert.equal(plan.fromSec, 10.65);
  assert.equal(plan.toSec, 11.8);
  assert.equal(plan.prefix?.fromSec, 10);
  assert.equal(plan.prefix?.toSec, 10.65);
  assert.equal(plan.suffix?.fromSec, 11.8);
  assert.equal(plan.suffix?.toSec, 12);
});

test('the parts keep their own word timings', () => {
  const plan = planWordCut(machli(), 7, 18);
  assert.deepEqual(
    plan?.cut.words?.map((w) => w.word),
    ['jal', 'ki', 'rani']
  );
  assert.deepEqual(
    plan?.prefix?.words?.map((w) => w.word),
    ['machli']
  );
  assert.deepEqual(
    plan?.suffix?.words?.map((w) => w.word),
    ['h']
  );
});

test('a selection covering every word is a whole-line cut, not a split', () => {
  const plan = planWordCut(machli(), 0, 20);
  assert.ok(plan);
  assert.equal(plan.whole, true);
  assert.equal(plan.prefix, null);
  assert.equal(plan.suffix, null);
  assert.equal(plan.cut.text, 'machli jal ki rani h');
  assert.equal(plan.fromSec, 10);
  assert.equal(plan.toSec, 12);
});

test('dragging halfway through a word expands to the whole word', () => {
  // Starts inside "jal", ends inside "ki".
  const plan = planWordCut(machli(), 8, 12);
  assert.ok(plan);
  assert.equal(plan.cut.text, 'jal ki');
  assert.equal(plan.prefix?.text, 'machli');
  assert.equal(plan.suffix?.text, 'rani h');
});

test('punctuation and case still pair with the plain word timings', () => {
  const line: TranscriptLine = {
    ...machli(),
    text: 'Machli, jal ki RANI h.',
    endSec: 12.4,
    words: [
      { word: 'Machli', start: 10, end: 10.6 },
      { word: 'jal', start: 10.65, end: 10.95 },
      { word: 'ki', start: 10.95, end: 11.2 },
      { word: 'rani', start: 11.2, end: 11.8 },
      { word: 'h', start: 11.85, end: 12.3 }
    ]
  };
  const plan = planWordCut(line, 8, 19);
  assert.ok(plan);
  assert.equal(plan.cut.text, 'jal ki RANI');
  assert.equal(plan.approx, false);
  // The suffix runs to the line's end, never past it.
  assert.equal(plan.suffix?.toSec, 12.4);
});

test('without word timings the cut is marked approximate and still covers the line', () => {
  const line: TranscriptLine = {
    id: 'l2',
    startSec: 20,
    endSec: 23,
    text: 'a bb ccc',
    flag: 'none',
    keep: 'keep',
    confidence: 1
  };
  const tokens = tokenizeLine(line.text, undefined, 20, 23);
  assert.equal(tokens.length, 3);
  assert.equal(
    tokens.every((t) => t.approx),
    true
  );
  assert.equal(tokens[0].startSec, 20);
  assert.equal(tokens[2].endSec, 23);
  // Times are monotonic and inside the line.
  for (let i = 1; i < tokens.length; i++) {
    assert.ok(tokens[i].startSec >= tokens[i - 1].endSec - 1e-9);
  }

  const plan = planWordCut(line, 3, 5); // "bb"
  assert.ok(plan);
  assert.equal(plan.approx, true);
  assert.equal(plan.cut.text, 'bb');
  assert.equal(plan.prefix?.text, 'a');
  assert.equal(plan.suffix?.text, 'ccc');
  assert.ok(plan.cut.fromSec >= 20 && plan.cut.toSec <= 23);
});

test('a click or a whitespace drag selects no word and does nothing', () => {
  assert.equal(planWordCut(machli(), 6, 7), null);
  assert.equal(planWordCut(machli(), 3, 3), null);
  assert.equal(planWordCut({ ...machli(), text: '   ' }, 0, 3), null);
});

test('an out-of-range selection is clamped to the text', () => {
  const plan = planWordCut(machli(), -50, 999);
  assert.ok(plan);
  assert.equal(plan.whole, true);
});

test('the toolbar counts words, not spaces', () => {
  assert.equal(wordCount('jal ki rani'), 3);
  assert.equal(wordCount('  ek   shabd  '), 2);
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   '), 0);
});
