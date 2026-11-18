import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SWIPE_COOLDOWN_MS, SWIPE_MIN_PX, SWIPE_PX, newSwipe, swipeFeed } from './browser-swipe.ts';

/** Feed a horizontal burst and collect every switch it fires. */
function burst(
  events: Array<[number, number]>,
  start = 1_000
): { go: Array<-1 | 1>; acc: ReturnType<typeof newSwipe> } {
  const acc = newSwipe();
  const go: Array<-1 | 1> = [];
  let now = start;
  for (const [dx, dy] of events) {
    const step = swipeFeed(acc, now, dx, dy);
    if (step !== 0) go.push(step);
    now += 16; // one frame between wheel events
  }
  return { go, acc };
}

describe('swipeFeed', () => {
  it('fires next tab when a leftward swipe crosses the threshold', () => {
    // fingers left → negative deltaX → 1 (next), one switch per swipe
    const { go, acc } = burst([
      [-30, 0],
      [-40, 0],
      [-55, 0]
    ]);
    assert.deepEqual(go, [1]);
    assert.equal(acc.px, 0, 'the accumulator resets after firing');
  });

  it('fires previous tab for a rightward swipe', () => {
    const { go } = burst([
      [40, 0],
      [45, 0],
      [50, 0]
    ]);
    assert.deepEqual(go, [-1]);
  });

  it('never fires below the threshold', () => {
    const { go, acc } = burst([
      [-40, 0],
      [-40, 0] // 80px total, short of SWIPE_PX
    ]);
    assert.deepEqual(go, []);
    assert.equal(acc.px, -80, 'the partial gesture is kept for the next event');
  });

  it('cancels on a vertical scroll — a page scroll never switches tabs', () => {
    const { go, acc } = burst([
      [-60, 0],
      [0, 24], // the user scrolled down mid-gesture
      [-70, 0] // would have crossed the threshold had it survived
    ]);
    assert.deepEqual(go, []);
    assert.equal(acc.px, -70, 'the gesture restarts after the cancel');
  });

  it('ignores horizontal jitter that rides along with a vertical scroll', () => {
    const { go, acc } = burst([
      [0, 40],
      [3, 38], // |dx| < SWIPE_MIN_PX, and vertical-dominant anyway
      [0, 42]
    ]);
    assert.deepEqual(go, []);
    assert.equal(acc.px, 0);
  });

  it('treats a diagonal event as vertical (dominant axis wins)', () => {
    const { acc } = burst([
      [-50, 80] // vertical-dominant → cancels instead of accumulating
    ]);
    assert.equal(acc.px, 0);
  });

  it('swallows the momentum after a fire (one swipe, one switch)', () => {
    const acc = newSwipe();
    const t = 5_000;
    assert.equal(swipeFeed(acc, t, -130, 0), 1, 'the swipe fires');
    // the same finger's momentum arrives over the next frames
    assert.equal(swipeFeed(acc, t + 40, -80, 0), 0, 'cooldown holds');
    assert.equal(swipeFeed(acc, t + 100, -60, 0), 0, 'still cooling');
    assert.equal(swipeFeed(acc, t + SWIPE_COOLDOWN_MS + 1, -60, 0), 0, 'a fresh gesture, 60px in');
    assert.equal(swipeFeed(acc, t + SWIPE_COOLDOWN_MS + 17, -70, 0), 1, 'and it can fire again');
  });

  it('fires a single-event flick when one event is past the threshold', () => {
    const { go } = burst([[-SWIPE_PX - 10, 0]]);
    assert.deepEqual(go, [1]);
  });

  it('keeps SWIPE_MIN_PX as the documented jitter floor', () => {
    assert.ok(SWIPE_MIN_PX > 0 && SWIPE_MIN_PX < SWIPE_PX);
  });
});
