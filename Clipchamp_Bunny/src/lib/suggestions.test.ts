import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LineFlag, KeepState, TranscriptLine } from './types.ts';
import {
  detectQualitySuggestions,
  fumbleReason,
  normalizeSpeech,
  similarity,
  speechTokens
} from './suggestions.ts';

/** A minimal transcript row; only the fields the detector reads matter. */
function line(
  id: string,
  startSec: number,
  endSec: number,
  text: string,
  extra: { flag?: LineFlag; keep?: KeepState } = {}
): TranscriptLine {
  return {
    id,
    startSec,
    endSec,
    text,
    flag: extra.flag ?? 'none',
    keep: extra.keep ?? 'keep',
    confidence: 0.9,
    words: []
  };
}

test('normalizeSpeech drops punctuation and case but keeps Hindi words', () => {
  assert.equal(normalizeSpeech('  Umm,  YAAAR — ye “kaam” hai!  '), 'umm yaaar ye kaam hai');
  assert.deepEqual(speechTokens('Matlab: ye kaam hai.'), ['matlab', 'ye', 'kaam', 'hai']);
});

test('similarity is token overlap, not character overlap', () => {
  assert.equal(similarity(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  assert.equal(similarity(['a', 'b'], ['c', 'd']), 0);
  assert.equal(similarity(['a', 'b', 'c', 'd'], ['a', 'b', 'x', 'd']), 0.6);
});

test('a line made only of fillers is a fumble', () => {
  const l = line('l1', 0, 2, 'umm aaa hmm');
  assert.match(fumbleReason(l) ?? '', /filler/i);
  assert.equal(detectQualitySuggestions([l]).length, 1);
});

test('a short line that opens with a filler is a fumble', () => {
  const l = line('l1', 0, 2, 'Uh, ye wala');
  assert.ok(fumbleReason(l));
});

test('a normal sentence that happens to start with a word is untouched', () => {
  const l = line('l1', 0, 4, 'Ye project ka pehla hissa hai');
  assert.equal(fumbleReason(l), null);
});

test('an immediate stutter is a fumble', () => {
  const l = line('l1', 0, 3, 'mai mai soch raha tha');
  assert.match(fumbleReason(l) ?? '', /stutter/i);
});

test('an abandoned take that ends on a dash is a fumble', () => {
  const l = line('l1', 0, 3, 'aur phir hum—');
  assert.match(fumbleReason(l) ?? '', /adhoora/i);
});

test('a line the cloud brain flagged is suggested even without text signals', () => {
  const l = line('l1', 0, 4, 'Ye bilkul theek sentence hai', { flag: 'repeat' });
  const got = detectQualitySuggestions([l]);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'repeat');
});

test('an exact retake suggests only the earlier line', () => {
  const lines = [
    line('a', 0, 4, 'aaj hum timeline banayenge'),
    line('b', 5, 9, 'aaj hum timeline banayenge')
  ];
  const got = detectQualitySuggestions(lines);
  assert.equal(got.length, 1);
  assert.equal(got[0].lineId, 'a');
  assert.equal(got[0].kind, 'repeat');
  assert.equal(got[0].startSec, 0);
});

test('a false start that the next line completes is cut, not the good take', () => {
  const lines = [
    line('a', 0, 2, 'aaj hum timeline'),
    line('b', 3, 8, 'aaj hum timeline banayenge aur export karenge')
  ];
  const got = detectQualitySuggestions(lines);
  assert.deepEqual(
    got.map((g) => g.lineId),
    ['a']
  );
});

test('a short echo is a real repeat, not a retake', () => {
  const lines = [line('a', 0, 1, 'haan'), line('b', 1.2, 2, 'haan')];
  assert.equal(detectQualitySuggestions(lines).length, 0);
});

test('different sentences produce no suggestions', () => {
  const lines = [
    line('a', 0, 4, 'pehle media import karo'),
    line('b', 5, 9, 'phir timeline par drag karo')
  ];
  assert.deepEqual(detectQualitySuggestions(lines), []);
});

test('already-cut lines are not suggested again', () => {
  const lines = [line('a', 0, 2, 'umm aaa', { keep: 'cut' })];
  assert.deepEqual(detectQualitySuggestions(lines), []);
});

test('suggestions come back in timeline order', () => {
  const lines = [
    line('a', 0, 2, 'umm'),
    line('b', 3, 7, 'ye theek hai'),
    line('c', 8, 10, 'uh, ye wala'),
    line('d', 11, 12, 'aaa')
  ];
  const got = detectQualitySuggestions(lines);
  assert.deepEqual(
    got.map((g) => g.lineId),
    ['a', 'c', 'd']
  );
});
