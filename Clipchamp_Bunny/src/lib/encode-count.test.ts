import test from 'node:test';
import assert from 'node:assert/strict';

import { bumpEncodes, encodesFor, generationWarning } from './encode-count.ts';

/** A minimal localStorage, because node's test runner has none. */
function installStorage() {
  const map = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
    removeItem: (k: string) => map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    }
  };
  return map;
}

test('a fresh source has no encodes', () => {
  installStorage();
  assert.deepEqual(encodesFor('/media/a.mp4'), { count: 0, lastUnix: 0 });
});

test('bumpEncodes counts per source and remembers the last time', () => {
  installStorage();
  assert.equal(bumpEncodes('/media/a.mp4', 1000), 1);
  assert.equal(bumpEncodes('/media/a.mp4', 2000), 2);
  assert.equal(encodesFor('/media/a.mp4').count, 2);
  assert.equal(encodesFor('/media/a.mp4').lastUnix, 2000);
  assert.equal(encodesFor('/media/b.mp4').count, 0);
});

test('corrupt storage reads as zero instead of throwing', () => {
  const map = installStorage();
  map.set('t9.encodes./media/a.mp4', '{not json');
  assert.deepEqual(encodesFor('/media/a.mp4'), { count: 0, lastUnix: 0 });
});

test('the warning arrives at the second pass, not before', () => {
  assert.equal(generationWarning(0), '');
  assert.equal(generationWarning(1), '');
  assert.match(generationWarning(2), /doosra export/);
  assert.match(generationWarning(4), /4 baar export/);
});

test('no storage at all still counts in memory', () => {
  delete (globalThis as Record<string, unknown>).localStorage;
  assert.equal(bumpEncodes('/media/a.mp4'), 1);
});
