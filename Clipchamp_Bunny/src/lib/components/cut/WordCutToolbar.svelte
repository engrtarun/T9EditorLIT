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
   */
  import { onMount } from 'svelte';

  interface Props {
    /** The exact words that will be cut, as they appear in the line. */
    text: string;
    /** True when the line has no word timings — the time is a character-count guess. */
    approx: boolean;
    words: number;
    /** Length of the range that will be removed, in seconds. */
    seconds: number;
    /** Viewport box of the selected words (see `readWordSelection`). */
    rect: { left: number; top: number; bottom: number; width: number };
    oncancel: () => void;
    oncut: () => void;
  }

  let { text, approx, words, seconds, rect, oncancel, oncut }: Props = $props();

  let card: HTMLDivElement | null = $state(null);
  let cutBtn: HTMLButtonElement | null = $state(null);

  /** Half the card width: the clamp keeps both edges on screen. */
  const HALF = 182;

  const above = $derived(rect.top > 150);
  const centerX = $derived(
    Math.min(Math.max(rect.left + rect.width / 2, HALF), Math.max(HALF, window.innerWidth - HALF))
  );
  const top = $derived(above ? Math.max(8, rect.top - 10) : rect.bottom + 10);

  const span = $derived(
    seconds >= 10 ? `${Math.round(seconds)}s` : `${Math.max(0.1, seconds).toFixed(1)}s`
  );

  onMount(() => {
    // Focus the primary action, so Enter confirms and the selection can still
    // be cancelled with Esc without hunting for the card.
    cutBtn?.focus({ preventScroll: true });
  });

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      if (e.key === 'Escape') {
        e.preventDefault();
        oncancel();
        return;
      }
      // Descript's habit: Delete removes the selected words. Backspace too,
      // because the two keys are muscle memory for the same action.
      if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
        e.preventDefault();
        oncut();
        return;
      }
      if (e.key === 'Enter' && document.activeElement !== cutBtn) {
        e.preventDefault();
        oncut();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
</script>

<div
  bind:this={card}
  role="toolbar"
  aria-label="Selected words — cut or cancel"
  aria-orientation="horizontal"
  tabindex="-1"
  class="fixed z-50 w-[364px] max-w-[calc(100vw-16px)] rounded-xl border border-nc-line-2
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
    {#if approx}
      <span
        class="mt-[1px] shrink-0 rounded border border-amber-400/40 bg-amber-400/10 px-1 text-[8px]
               font-bold tracking-wider text-amber-300"
        title="Is line me word timings nahi hain — cut words ke character count se baanta jayega"
      >
        APPROX
      </span>
    {/if}
  </div>

  <div class="mt-2 flex items-center gap-1.5">
    <span class="min-w-0 truncate font-mono text-[9.5px] text-nc-mut-2">
      {span} · {words}
      {words === 1 ? 'word' : 'words'}
    </span>
    <span class="flex-1"></span>
    <button
      onclick={oncancel}
      class="rounded-md px-2 py-1 text-[10.5px] font-medium text-nc-mut transition-colors
             hover:bg-nc-panel-2 hover:text-nc-txt"
      title="Selection clear karo (Esc)"
    >
      Cancel
    </button>
    <button
      bind:this={cutBtn}
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
