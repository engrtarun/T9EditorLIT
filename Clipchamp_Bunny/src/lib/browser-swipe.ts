/**
 * Two-finger horizontal swipe → previous/next tab.
 *
 * Firefox's trackpad gesture, asked for directly: "firefox ki tarah 2unglis
 * se left right se previous or next tab me jaya ja sake". The Windows
 * precision touchpad reports one swipe as a *burst* of small horizontal
 * `wheel` events, so the gesture has to be accumulated, never matched to a
 * single event:
 *
 *   · horizontal-dominant events add up (`|dx| > |dy|`, sub-4px jitter
 *     ignored — a vertical scroll bleeds a little sideways on a real pad),
 *   · any vertical scroll cancels it: scrolling a page must never switch
 *     tabs,
 *   · ±`SWIPE_PX` pixels of travel fires exactly one switch, then a short
 *     cooldown swallows the momentum so one swipe cannot fire twice.
 *
 * Sign convention: Windows scrolls classically (content follows the fingers'
 * direction of travel — fingers left, viewport left), so a swipe to the LEFT
 * gives a negative `deltaX`, and left means NEXT: fingers left, tabs forward.
 * If a machine's pad is set the other way, this one line is the flip.
 *
 * Two callers, because a native child window swallows events before the
 * shell ever sees them:
 *
 *   · `src-tauri/src/browser_shim.js` hears the wheel over PAGE content (a
 *     WebView2 child HWND never reaches this window's listeners) and reports
 *     it as `{ t9: 'key', action: 'nextTab' | 'prevTab' }` — the same
 *     contract Ctrl+Tab already uses;
 *   · `BrowserView.svelte` hears it over the app's own chrome (dial, bars).
 *
 * The shim is a standalone document-start script compiled into the binary,
 * so it mirrors this logic instead of importing it — the constants below are
 * copied there; change one, change both.
 */

/** Horizontal pixels of travel that make one tab switch. */
export const SWIPE_PX = 120;
/** Per-event jitter below this never counts (a pad's diagonal bleed). */
export const SWIPE_MIN_PX = 4;
/** After a switch, momentum events are ignored for this long (ms). */
export const SWIPE_COOLDOWN_MS = 300;

/** The running total of one gesture. */
export interface SwipeAcc {
  px: number;
  /** Epoch ms until which horizontal events are ignored (post-fire momentum). */
  until: number;
}

/** A fresh gesture. */
export function newSwipe(): SwipeAcc {
  return { px: 0, until: 0 };
}

/**
 * Feed one wheel event (pixel units — the caller normalizes `deltaMode`).
 * Returns 1 (next tab), -1 (previous tab) or 0 (keep accumulating / idle).
 */
export function swipeFeed(acc: SwipeAcc, now: number, deltaX: number, deltaY: number): -1 | 0 | 1 {
  if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) >= SWIPE_MIN_PX) {
    if (now < acc.until) return 0; // the swipe already fired; this is its tail
    acc.px += deltaX;
    if (acc.px <= -SWIPE_PX) {
      acc.px = 0;
      acc.until = now + SWIPE_COOLDOWN_MS;
      return 1; // fingers left → next tab
    }
    if (acc.px >= SWIPE_PX) {
      acc.px = 0;
      acc.until = now + SWIPE_COOLDOWN_MS;
      return -1; // fingers right → previous tab
    }
    return 0;
  }
  // Vertical-dominant (or sub-pixel) wheel: the gesture is dead. A real
  // swipe never contains it, so this is what keeps a page scroll honest.
  if (deltaY !== 0) acc.px = 0;
  return 0;
}
