<script lang="ts">
  /**
   * The confirmation toolbar for a word-level cut.
   *
   * Pattern taken from the editors that do text-based cutting well (Descript's
   * selection toolbar, Notion's floating toolbar): the action appears **at the
   * selection**, names the words, and is confirmed with Enter — instead of a
   * fixed footer the user has to find. Deleting words is destructive-looking,
   * so it stays a two-step: drag, then Cut. The row is not touched until then.
   *
   * It is fixed-position because it must escape the transcript's scroll
   * container; `above` flips it over the words when the selection is low on the
   * screen, and the horizontal clamp keeps it inside a narrow window.
   *
   * The range is printed to the millisecond on purpose. "0.9s" hides whether
   * the cut starts on the pause or 80 ms into the previous word; `0:01.240 →
   * 0:02.980` is a claim the user can check against the audio, and it is the
   * exact range `cutWords` will use.
   */
  import { fmtMs } from '../../utils';

  interface Props {
    /** The exact words that will be cut, as they appear in the line. */
    text: string;
    /** Clock range `cutWords` will remove, after the audio snap. */
    fromSec: number;
    toSec: number;
    /** True when the boundaries were pulled onto a real pause in the audio. */
    snapped: boolean;
    words: number;
    /** Viewport box of the selected words (see `readWordSelection`). */
    rect: { left: number; top: number; bottom: number; width: number };
    oncancel: () => void;
    oncut: () => void;
  }

  let { text, fromSec, toSec, snapped, words, rect, oncancel, oncut }: Props = $props();

  /** Half the card width: the clamp keeps both edges on screen. */
  const HALF = 190;

  const above = $derived(rect.top > 150);
  const centerX = $derived(
    Math.min(Math.max(rect.left + rect.width / 2, HALF), Math.max(HALF, window.innerWidth - HALF))
  );
  const top = $derived(above ? Math.max(8, rect.top - 10) : rect.bottom + 10);

  const span = $derived(Math.max(0, toSec - fromSec));
  const length = $derived(span >= 10 ? `${span.toFixed(2)}s` : `${span.toFixed(3)}s`);

  /**
   * The keyboard lives on `window` and the card never steals focus.
   *
   * Focusing the Cut button here would be the obvious accessibility move, but
   * this toolbar appears **while the mouse is still dragging** — a programmatic
   * focus in the middle of a text-selection drag can end the drag, and the
   * whole point of the live watcher is that the selection keeps growing under
   * the pointer. Enter / Delete / Esc are handled globally instead.
   */
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        oncancel();
        return;
      }
      // Descript's habit: Delete removes the selected words. Backspace too,
      // because the two keys are muscle memory for the same action.
      if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
        e.preventDefault();
        // The editor's own Delete/Keep handlers are global too: without this
        // the same keypress would cut the selection *and* the whole line.
        e.stopImmediatePropagation();
        oncut();
        return;
      }
      // A focused toolbar button owns its own Enter (it clicks itself); every
      // other focus means "confirm the words".
      if (e.key === 'Enter' && !typing && !el?.matches('[role="toolbar"] button')) {
        e.preventDefault();
        // Same reason as Delete: Enter must not also fire another shortcut.
        e.stopImmediatePropagation();
        oncut();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
</script>

<div
  role="toolbar"
  aria-label="Selected words — cut or cancel"
  aria-orientation="horizontal"
  tabindex="-1"
  class="fixed z-50 w-[380px] max-w-[calc(100vw-16px)] rounded-xl border border-nc-line-2
         bg-nc-panel/95 p-2.5 shadow-2xl shadow-black/50 backdrop-blur-md"
  style="left:{centerX}px; top:{top}px; transform:translate(-50%, {above ? '-100%' : '0'});"
  onmousedown={(e) => e.preventDefault()}
>
  <div class="flex items-start gap-2">
    <span
      class="mt-[1px] grid h-5 w-5 shrink-0 place-items-center rounded bg-nc-red/15 text-nc-red"
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        aria-hidden="true"
      >
        <circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" />
        <path d="M8 7.6L20 19M8 16.4L20 5" />
      </svg>
    </span>
    <p class="line-clamp-2 min-w-0 flex-1 text-[11.5px] leading-snug text-nc-txt" title={text}>
      “{text}”
    </p>
  </div>

  <div class="mt-1.5 pl-7">
    <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10px] leading-4">
      <span class="font-semibold text-nc-txt">{fmtMs(fromSec)}</span>
      <span class="text-nc-mut-2" aria-hidden="true">→</span>
      <span class="font-semibold text-nc-txt">{fmtMs(toSec)}</span>
      {#if snapped}
        <span
          class="ml-0.5 inline-flex items-center gap-0.5 rounded bg-nc-brand/12 px-1 py-px
                 font-sans text-[8px] font-semibold tracking-wide text-nc-brand"
          title="Boundaries audio ke asli quiet gap par snap hui hain — yahi millisecond cut hoga"
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="2" y="9" width="2.4" height="6" rx="1" />
            <rect x="7" y="5" width="2.4" height="14" rx="1" />
            <rect x="12" y="7" width="2.4" height="10" rx="1" />
            <rect x="17" y="3" width="2.4" height="18" rx="1" />
          </svg>
          AUDIO SNAP
        </span>
      {/if}
    </div>
    <p class="mt-0.5 font-mono text-[9.5px] text-nc-mut-2">
      {length} · {words}
      {words === 1 ? 'word' : 'words'}
    </p>
  </div>

  <div class="mt-2 flex items-center justify-end gap-1.5">
    <button
      onclick={oncancel}
      class="rounded-md px-2 py-1 text-[10.5px] font-medium text-nc-mut transition-colors
             hover:bg-nc-panel-2 hover:text-nc-txt"
      title="Selection clear karo (Esc)"
    >
      Cancel
    </button>
    <button
      onclick={oncut}
      class="flex items-center gap-1.5 rounded-md bg-nc-red px-2.5 py-1 text-[10.5px] font-semibold
             text-white transition-[filter] duration-150 hover:brightness-110"
      title="Selected words cut karo (Enter / Delete)"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.6"
        aria-hidden="true"
      >
        <circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" />
        <path d="M8 7.6L20 19M8 16.4L20 5" />
      </svg>
      Cut
      <kbd
        class="rounded border border-white/25 px-1 font-mono text-[8.5px] font-normal text-white/80"
        >⏎</kbd
      >
    </button>
  </div>
</div>
