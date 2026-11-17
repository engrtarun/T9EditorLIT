<script lang="ts">
  import { fly } from 'svelte/transition';
  import { backOut, cubicOut } from 'svelte/easing';
  import { toast, type ToastKind } from '../stores/toast.svelte';

  /**
   * The app's one notification voice — every cut, keep, split, engine switch
   * and warning comes through here, so this is where the brand's motion lives.
   *
   * The shape is the one that reads as current without being a costume:
   * a glass pill that springs up from the bottom edge (overshoot, then settle),
   * a kind mark that pops in a beat later, and a thin bar under the text that
   * drains for exactly as long as the toast will live — so the wait is visible
   * instead of a guessing game. It leaves with a small rise and a fade.
   *
   * Enter/exit are Svelte transitions, not stacked CSS animations: a delayed
   * exit animation on the same element would win the cascade during its delay
   * and blank the entrance. `in:` and `out:` never fight.
   *
   * Reduced Motion (app setting or Windows) keeps every word and the drain
   * bar's full length, and drops only the travel: a changing fact is content,
   * motion is decoration.
   */
  const STYLE: Record<ToastKind, string> = {
    info: 'border-nc-line-2 bg-nc-panel-2/95 text-nc-txt',
    cut: 'border-nc-red/50 bg-nc-red/12 text-nc-red',
    keep: 'border-nc-green/50 bg-nc-green/12 text-nc-green',
    split: 'border-nc-brand/50 bg-nc-brand/12 text-nc-brand',
    warn: 'border-nc-red/50 bg-nc-panel-2/95 text-nc-txt'
  };

  /** The bar and the mark follow the kind, one ramp, no raw hex. */
  const BAR: Record<ToastKind, string> = {
    info: 'bg-nc-mut',
    cut: 'bg-nc-red',
    keep: 'bg-nc-green',
    split: 'bg-nc-brand',
    warn: 'bg-nc-red'
  };

  /** A distinct mark per kind, so colour is never the only signal. */
  const ICON: Record<ToastKind, string> = {
    info: 'M12 8h.01M11 12h1v4h1',
    cut: 'M6 6l12 12M18 6L6 18',
    keep: 'M5 13l4 4L19 7',
    split: 'M4 12h6m0 0 4-5m-4 5 4 5M20 12h-4',
    warn: 'M12 8v5m0 3h.01M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'
  };

  const reduceMotion = $derived(
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  /* Hover or keyboard focus holds the toast: the reader sets the pace, not the
     clock. The bar freezes through the same CSS `animation-play-state`, so the
     two never disagree about how long is left. */
  function hold(id: number) {
    toast.pause(id);
  }
  function release(id: number) {
    toast.resume(id);
  }
</script>

<!-- Micro feedback — every cut, keep and split confirms instantly -->
<div
  class="pointer-events-none fixed bottom-6 left-1/2 z-[350] flex -translate-x-1/2 flex-col items-center gap-2"
  role="status"
  aria-live="polite"
>
  {#each toast.items as t (t.id)}
    <div
      class="group relative overflow-hidden rounded-full border pl-2.5 pr-4 py-1.5
             text-[12px] font-medium shadow-[0_8px_30px_rgba(0,0,0,.45)] backdrop-blur-md {STYLE[
        t.kind
      ]}"
      role="presentation"
      onpointerenter={() => hold(t.id)}
      onpointerleave={() => release(t.id)}
      onfocusin={() => hold(t.id)}
      onfocusout={() => release(t.id)}
      in:fly={{
        y: reduceMotion ? 0 : 14,
        duration: reduceMotion ? 1 : 380,
        easing: backOut
      }}
      out:fly={{
        y: reduceMotion ? 0 : -8,
        duration: reduceMotion ? 1 : 200,
        easing: cubicOut
      }}
    >
      <span class="flex items-center gap-2">
        <span
          class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/10 {BAR[t.kind]}"
          aria-hidden="true"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="text-white"
          >
            <path d={ICON[t.kind]} />
          </svg>
        </span>
        <span>{t.text}</span>
      </span>

      <!-- the drain: one bar, full width at birth, empty when it leaves -->
      <span
        class="t9-toast-drain absolute inset-x-0 bottom-0 h-[2px] origin-left {BAR[t.kind]}"
        style="animation-duration:{t.ms}ms"
        aria-hidden="true"
      ></span>
    </div>
  {/each}
</div>

<style>
  /*
   * The mark lands a beat after the pill — one detail that makes it feel
   * composed rather than pasted on. It is a plain entrance (no exit): the
   * mark leaves with its pill, and a second animation on it would only
   * fight the parent's transition.
   */
  @keyframes t9-toast-pop {
    from {
      opacity: 0;
      transform: scale(0.4) rotate(-12deg);
    }
    to {
      opacity: 1;
      transform: scale(1) rotate(0deg);
    }
  }

  @keyframes t9-toast-drain {
    from {
      transform: scaleX(1);
    }
    to {
      transform: scaleX(0);
    }
  }

  .t9-toast-mark {
    animation: t9-toast-pop 300ms cubic-bezier(0.22, 1.4, 0.36, 1) 140ms both;
  }

  .t9-toast-drain {
    animation: t9-toast-drain linear both;
  }

  /* Hover / focus stops the bar where it is — the same hold the store applies
     to the dismiss timer, so the visible clock and the real one agree. */
  .group:hover .t9-toast-drain,
  .group:focus-within .t9-toast-drain {
    animation-play-state: paused;
  }

  @media (prefers-reduced-motion: reduce) {
    .t9-toast-mark {
      animation: none;
    }

    .t9-toast-drain {
      animation: none;
      transform: scaleX(1);
    }
  }
</style>
