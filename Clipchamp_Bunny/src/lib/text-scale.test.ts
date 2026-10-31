import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scaleText } from '../../tools/text-scale-plugin.ts';

/**
 * The text-scale plugin rewrites every font-size in the bundle. It once dropped
 * the property name and emitted `calc(9px: * var(--t9-text-scale, 1))`, which
 * the browser discards — every size in the app silently fell back to 16 px.
 * These tests pin the property name in place.
 */

test('font-size keeps its property and wraps only the value', () => {
  assert.equal(
    scaleText('.a { font-size: 9px; }'),
    '.a { font-size: calc(9px * var(--t9-text-scale, 1)); }'
  );
});

test('line-height scales with the same unit it was written in', () => {
  assert.equal(
    scaleText('.a { line-height: 1.25rem; }'),
    '.a { line-height: calc(1.25rem * var(--t9-text-scale, 1)); }'
  );
});

test('theme text tokens are rewritten, not renamed', () => {
  assert.equal(
    scaleText(':root { --text-sm: 0.875rem; }'),
    ':root { --text-sm: calc(0.875rem * var(--t9-text-scale, 1)); }'
  );
});

test('the rewrite never emits a colon inside calc', () => {
  const out = scaleText('.a { font-size: 13px; --text-base: 1rem; }');
  assert.ok(!out.includes('px:'), `property name was eaten: ${out}`);
  assert.ok(!out.includes('rem:'), `property name was eaten: ${out}`);
});

test('a second pass changes nothing', () => {
  const once = scaleText('.a { font-size: 13px; }');
  assert.equal(scaleText(once), once);
});

test('unitless line-heights are ratios and stay untouched', () => {
  assert.equal(scaleText('.a { line-height: 1.5; }'), '.a { line-height: 1.5; }');
});
