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

test('Devanagari matras keep words distinct when pairing timings', () => {
  // "कल" and "काल" differ only by a matra. Stripping marks compared them as
  // the same word, so the first token could take the *wrong* take's clock — a
  // word cut then removed the wrong audio. Marks are part of the word.
  const line: TranscriptLine = {
    id: 'hi',
    startSec: 1,
    endSec: 1.8,
    text: 'काल कल',
    flag: 'none',
    keep: 'keep',
    confidence: 1,
    words: [
      // The file's order is the opposite of the text on purpose: only a real
      // word comparison can pick the second entry for "काल".
      { word: 'कल', start: 1, end: 1.3 },
      { word: 'काल', start: 1.4, end: 1.7 }
    ]
  };
  const tokens = tokenizeLine(line.text, line.words, line.startSec, line.endSec);
  assert.equal(tokens[0].text, 'काल');
  assert.equal(tokens[0].startSec, 1.4, 'काल must not pair with कल');
  assert.equal(tokens[0].wordFrom, 1);
});

test('a part that would last zero seconds is not created', () => {
  // Word timings can overlap: here the second word starts on the same
  // millisecond as the line. A "prefix" from 10.0 to 10.0 would be an empty row
  // on the timeline, so it must not be a part at all — that is the
  // "clip is too small" case.
  const line: TranscriptLine = {
    id: 'l3',
    startSec: 10,
    endSec: 10.6,
    text: 'machli jal',
    flag: 'none',
    keep: 'keep',
    confidence: 1,
    words: [
      { word: 'machli', start: 10, end: 10.3 },
      { word: 'jal', start: 10, end: 10.6 }
    ]
  };
  const plan = planWordCut(line, 7, 9);
  assert.ok(plan);
  assert.equal(plan.prefix, null);
  assert.equal(plan.suffix, null);
  assert.equal(plan.cut.fromSec, 10);
  assert.equal(plan.cut.toSec, 10.6);
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
