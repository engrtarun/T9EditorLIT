import test from 'node:test';
import assert from 'node:assert/strict';

import { LANGUAGES, isLanguageSwitch, languageLabel } from './languages.ts';

// Every code has to be one the API accepts: a made-up code is a 400 from the
// provider, and the whole point of the dropdown is to avoid that.
test('every language code is an ISO-639-1 pair', () => {
  for (const l of LANGUAGES) {
    assert.match(l.code, /^[a-z]{2}$/, `${l.code} is not an ISO-639-1 code`);
  }
});

// The list must not carry the same code twice: two entries for one language
// means one of them is unreachable.
test('no language appears twice', () => {
  const seen = new Set<string>();
  for (const l of LANGUAGES) {
    assert.equal(seen.has(l.code), false, `${l.code} is listed twice`);
    seen.add(l.code);
  }
});

// A badge has to be short: it sits on a transcript row.
test('the badge label is the bare name', () => {
  assert.equal(languageLabel('hi'), 'हिन्दी');
  assert.equal(languageLabel('en'), 'English');
  // A language the dropdown does not carry still gets a readable badge.
  assert.equal(languageLabel('sw'), 'SW');
  assert.equal(languageLabel(null), '');
});

// The badge only appears on the odd line out.
test('the badge shows only where the language changes', () => {
  assert.equal(isLanguageSwitch('hi', 'hi'), false);
  assert.equal(isLanguageSwitch('en', 'hi'), true);
  assert.equal(isLanguageSwitch(undefined, 'hi'), false);
  // A transcript with no job language yet: every badge is worth showing.
  assert.equal(isLanguageSwitch('hi', null), true);
});
