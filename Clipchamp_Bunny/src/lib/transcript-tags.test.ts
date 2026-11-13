import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTaggedText, tagIcon, tagLabel, tagsOf } from './transcript-tags.ts';

test('known bracket tags are found, case-insensitively', () => {
  assert.deepEqual(tagsOf('[Music] hello (applause)'), ['music', 'applause']);
  assert.deepEqual(tagsOf('(Laughter)'), ['laughter']);
  assert.deepEqual(tagsOf('♪ intro'), ['music']);
});

test('ordinary parentheses are content, not a sound effect', () => {
  assert.deepEqual(tagsOf('see (chapter 3)'), []);
  assert.deepEqual(tagsOf('(2024) recap'), []);
});

test('local-language sound cues become noise', () => {
  assert.deepEqual(tagsOf('[संगीत] shuru'), ['noise']);
});

test('tags are deduplicated and ordered', () => {
  assert.deepEqual(tagsOf('[Music] then [music] again'), ['music']);
});

test('renderTaggedText replaces only known tags', () => {
  assert.equal(
    renderTaggedText('[Music] intro (applause) (2024) notes'),
    '♪ intro 👏 (2024) notes'
  );
  assert.equal(renderTaggedText('plain words'), 'plain words');
  assert.equal(renderTaggedText('(applause)'), '👏');
});

test('icons and labels are stable', () => {
  assert.equal(tagIcon('music'), '♪');
  assert.equal(tagIcon('applause'), '👏');
  assert.equal(tagIcon('something-else'), '🔊');
  assert.equal(tagLabel('music'), 'Music');
});
