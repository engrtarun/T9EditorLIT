/**
 * The in-page shim must bind *exactly* the same map as browser-keys.ts.
 *
 * The shim cannot import the TypeScript module (it is injected into every
 * page as a document-start script), so the table is duplicated there. This
 * test is the thing that makes the duplication safe: it parses the shim's
 * `KEYS` rows and compares combo, action, value and the whileTyping flag with
 * `BINDINGS`. Adding a shortcut on one side and forgetting the other fails
 * here instead of silently doing nothing when the page has focus.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BINDINGS, comboValue } from './browser-keys.ts';

const shimPath = fileURLToPath(new URL('../../src-tauri/src/browser_shim.js', import.meta.url));

interface Row {
  combo: string;
  action: string;
  value: number;
  whileTyping: boolean;
}

function shimRows(): Row[] {
  const text = readFileSync(shimPath, 'utf8');
  const start = text.indexOf('const KEYS = [');
  assert.ok(start >= 0, 'browser_shim.js has no KEYS table');
  const end = text.indexOf('];', start);
  assert.ok(end > start, 'browser_shim.js KEYS table is unterminated');
  const block = text.slice(start, end);
  const rows: Row[] = [];
  const row = /\[\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(-?\d+)\s*,\s*(true|false)\s*\]/g;
  for (const m of block.matchAll(row)) {
    rows.push({
      combo: m[1],
      action: m[2],
      value: Number(m[3]),
      whileTyping: m[4] === 'true'
    });
  }
  assert.ok(rows.length >= 20, `parsed only ${rows.length} shim rows`);
  return rows;
}

const keyOf = (r: Row): string => `${r.combo}|${r.action}|${r.value}|${r.whileTyping}`;

test('page shim binds exactly the browser-keys.ts map', () => {
  const expected = BINDINGS.flatMap((entry) =>
    entry.combos.map((combo) => ({
      combo,
      action: entry.action,
      value: comboValue(entry.action as string, combo),
      whileTyping: Boolean(entry.whileTyping)
    }))
  );
  const shim = shimRows();
  const want = new Set(expected.map(keyOf));
  const got = new Set(shim.map(keyOf));
  const missing = [...want].filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !want.has(k));
  assert.deepEqual(extra, [], 'shim has shortcuts that browser-keys.ts does not');
  assert.deepEqual(missing, [], 'shim is missing shortcuts from browser-keys.ts');
});

test('shim rows are unique (first match wins, so duplicates hide one)', () => {
  const rows = shimRows();
  const combos = rows.map((r) => r.combo);
  assert.equal(new Set(combos).size, combos.length);
});

test('typing guard is explicit for every row', () => {
  // A missing 4th column would parse as no row at all above; this also keeps
  // the Firefox rule honest for the five chords users type most.
  const rows = shimRows();
  const typing = new Set(rows.filter((r) => r.whileTyping).map((r) => `${r.combo} ${r.action}`));
  for (const combo of ['ctrl+t', 'ctrl+w', 'ctrl+shift+t', 'ctrl+shift+p', 'ctrl+l']) {
    assert.ok(
      [...typing].some((k) => k.startsWith(`${combo} `)),
      `${combo} must work while typing`
    );
  }
  for (const combo of ['ctrl+c', 'ctrl+v', 'ctrl+a', 'ctrl+z']) {
    assert.ok(!rows.some((r) => r.combo === combo), `${combo} must stay with the page`);
  }
});
