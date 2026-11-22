import assert from 'node:assert/strict';
import test from 'node:test';
import { UNVERIFIED_RELEASE, WHATS_NEW_RELEASES, whatsNewFor } from './whatsnew.ts';

test('notes are looked up by the exact staged build id', () => {
  const release = WHATS_NEW_RELEASES[0];
  assert.equal(whatsNewFor(release.buildId), release);
});

test('an unknown build never receives an older build’s notes', () => {
  assert.equal(whatsNewFor('ci-does-not-exist'), UNVERIFIED_RELEASE);
  assert.equal(whatsNewFor(undefined), UNVERIFIED_RELEASE);
  assert.equal(whatsNewFor(''), UNVERIFIED_RELEASE);
});

test('a partial or prefixed build id is not a match', () => {
  const id = WHATS_NEW_RELEASES[0].buildId;
  assert.equal(whatsNewFor(id.slice(0, -2)), UNVERIFIED_RELEASE);
  assert.equal(whatsNewFor(`v${id}`), UNVERIFIED_RELEASE);
});

test('matching is case-insensitive but otherwise exact', () => {
  const release = WHATS_NEW_RELEASES[0];
  assert.equal(whatsNewFor(release.buildId.toUpperCase()), release);
});

test('every release is bound to a real build and has verified content', () => {
  assert.ok(WHATS_NEW_RELEASES.length > 0);
  for (const release of WHATS_NEW_RELEASES) {
    assert.match(release.buildId, /^ci-[0-9a-f]+$/);
    assert.ok(release.items.length > 0);
    assert.ok(!/reference|evergreen/i.test(release.headline));
    for (const item of release.items) {
      assert.ok(item.title.length > 0);
      assert.ok(item.detail.length > 0);
      assert.ok(item.reason.length > 0, `${item.title} needs a reason`);
    }
  }
});

test('the unverified state carries no claim about a shipped build', () => {
  assert.equal(UNVERIFIED_RELEASE.buildId, '');
  assert.ok(UNVERIFIED_RELEASE.items.length > 0);
});
