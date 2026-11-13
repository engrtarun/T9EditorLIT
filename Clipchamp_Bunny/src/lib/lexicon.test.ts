import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ALIASES_PER_TERM,
  countHits,
  entryLabel,
  mergeLexicon,
  normalizeEntry,
  normalizeLexicon
} from './lexicon.ts';

test('normalizeEntry trims, dedupes and drops self-aliases', () => {
  const out = normalizeEntry({
    term: '  RAG  ',
    aliases: [' rag ', 'रैग', 'रैग', '', 'राग']
  });
  assert.deepEqual(out, { term: 'RAG', aliases: ['रैग', 'राग'] });
});

test('normalizeEntry rejects an empty or overlong term', () => {
  assert.equal(normalizeEntry({ term: '   ', aliases: [] }), null);
  assert.equal(normalizeEntry({ term: 'x'.repeat(61), aliases: [] }), null);
});

test('aliases are capped', () => {
  const out = normalizeEntry({
    term: 'API',
    aliases: Array.from({ length: 20 }, (_, i) => `alias-${i}`)
  });
  assert.equal(out?.aliases.length, MAX_ALIASES_PER_TERM);
});

test('normalizeLexicon drops duplicate terms', () => {
  const out = normalizeLexicon([
    { term: 'RAG', aliases: ['रैग'] },
    { term: 'rag', aliases: ['राग'] },
    { term: 'LLM', aliases: [] }
  ]);
  assert.deepEqual(
    out.map((e) => e.term),
    ['RAG', 'LLM']
  );
});

test('mergeLexicon keeps local additions first', () => {
  const out = mergeLexicon(
    [{ term: 'RAG', aliases: ['रैग'] }],
    [{ term: 'UPI', aliases: ['यू पी आई'] }]
  );
  assert.deepEqual(
    out.map((e) => e.term),
    ['UPI', 'RAG']
  );
});

test('entryLabel shows the aliases', () => {
  assert.equal(entryLabel({ term: 'RAG', aliases: ['रैग', 'राग'] }), 'RAG (रैग, राग)');
  assert.equal(entryLabel({ term: 'LLM', aliases: [] }), 'LLM');
});

test('countHits is a cheap preview of the daemon pass', () => {
  const entries = [
    { term: 'RAG', aliases: ['retrive argument document general'] },
    { term: 'ChatGPT', aliases: ['चैनल जीपीटी'] }
  ];
  assert.deepEqual(countHits('RAG ko retrive argument document general bolte hain', entries), [
    'RAG'
  ]);
  assert.deepEqual(countHits('चैनल जीपीटी kya hai', entries), ['ChatGPT']);
  assert.deepEqual(countHits('kuch aur baat', entries), []);
});
