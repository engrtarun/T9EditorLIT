<script lang="ts">
  /**
   * DANGER NOTICE — the "Empty Trash" confirmation, written to be felt.
   *
   * The old flow was a plain `window.confirm` — eleven words and two grey
   * buttons, for an action that deletes records permanently. This notice
   * makes the weight visible: a red vignette swallows the screen, the card
   * shakes in, the border pulse never stops, the hazard band keeps crawling,
   * and the copy is in caps-and-countdown English. Everything animated is
   * opacity + transform only — the compositor runs it, no layout thrash, no
   * heap churn (the repo's zero-RAM rule costs nothing here).
   *
   * The confirm button does NOT delete anything by itself: it closes the
   * notice and calls `onconfirm`, which is the dashboard's real purge path.
   * English is hardcoded on purpose — this screen is a shout, not a sentence.
   */
  interface Props {
    open: boolean;
    /** How many bin items are about to die — the number does the talking. */
    count: number;
    onconfirm: () => void;
  }

  let { open = $bindable(false), count = 0, onconfirm }: Props = $props();

  function cancel() {
    open = false;
  }

  function confirm() {
    open = false;
    onconfirm();
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (open && e.key === 'Escape') cancel();
  }}
/>

{#if open}
  <!-- The red vignette: the screen itself turns dangerous before the card lands. -->
  <div
    class="danger-scrim fixed inset-0 z-[70] grid place-items-center p-4"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) cancel();
    }}
  >
    <div
      role="alertdialog"
      aria-modal="true"
      tabindex="-1"
      class="danger-card relative w-full max-w-[440px] overflow-hidden rounded-2xl border border-nc-red/55 bg-[#1b0d10] shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
    >
      <div class="hazard-stripes h-2 w-full" aria-hidden="true"></div>

      <div class="flex flex-col items-center px-6 pt-6 pb-6 text-center">
        <svg
          class="danger-icon text-nc-red"
          width="44"
          height="44"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.9"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>

        <h2 class="danger-title mt-2 text-[22px] font-black tracking-[0.18em] text-nc-red">
          DANGER&nbsp;ZONE
        </h2>
        <p class="mt-1 text-[13px] text-nc-mut">You are about to empty the Trash.</p>

        <p class="mt-4 text-[14px] leading-relaxed text-nc-txt">
          <span class="danger-count mx-1 inline-block rounded-md border border-nc-red/50 px-2 py-0.5">
            {count}
          </span>
          deleted item{count === 1 ? '' : 's'} will be gone
          <b class="font-black">FOREVER</b>.
        </p>
        <p class="danger-slow mt-2 text-[11.5px] font-semibold tracking-wide text-nc-red/85">
          NO&nbsp;UNDO. NO&nbsp;RESTORE. NO&nbsp;MERCY.
        </p>

        <div class="mt-6 flex w-full flex-col gap-2.5">
          <button
            class="hazard-stripes w-full rounded-xl px-4 py-2.5 text-[13px] font-black tracking-wide text-white transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]"
            onclick={confirm}
          >
            YES — DELETE ALL {count} ITEM{count === 1 ? '' : 'S'}
          </button>
          <button
            class="w-full rounded-xl border border-nc-line bg-nc-panel px-4 py-2.5 text-[13px] font-medium text-nc-txt transition-colors duration-150 hover:border-nc-brand/50 hover:text-nc-brand"
            onclick={cancel}
          >
            KEEP MY TRASH
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Everything runs on the compositor: opacity + transform only. */

  .danger-scrim {
    animation: danger-scrim-in 260ms ease-out both, danger-scrim-pulse 1.6s ease-in-out 260ms infinite;
  }

  .danger-card {
    animation: danger-shake-in 520ms cubic-bezier(0.22, 1.2, 0.36, 1) both,
      danger-glow 1.6s ease-in-out 300ms infinite;
  }

  .danger-title {
    text-shadow: 0 0 18px rgb(255 64 64 / 0.45);
    animation: danger-title-flash 2.2s ease-in-out infinite;
  }

  .danger-icon {
    filter: drop-shadow(0 0 12px rgb(255 64 64 / 0.5));
    animation: danger-heartbeat 1.05s ease-in-out infinite;
    transform-origin: 50% 60%;
  }

  .danger-count {
    animation: danger-count-pulse 1.6s ease-in-out infinite;
  }

  .danger-slow {
    animation: danger-slow-blink 2.4s ease-in-out infinite;
  }

  .hazard-stripes {
    background-image: repeating-linear-gradient(
      45deg,
      rgb(255 59 59 / 0.85) 0px,
      rgb(255 59 59 / 0.85) 12px,
      rgb(28 10 12 / 0.9) 12px,
      rgb(28 10 12 / 0.9) 24px
    );
    background-size: 200% 100%;
    animation: hazard-crawl 1.4s linear infinite;
  }

  button.hazard-stripes {
    border: 1px solid rgb(255 59 59 / 0.6);
    box-shadow: 0 6px 22px rgb(255 59 59 / 0.28);
  }

  .danger-scrim::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(ellipse at center, transparent 30%, rgb(140 8 16 / 0.36) 100%);
  }

  @keyframes danger-scrim-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes danger-scrim-pulse {
    0%,
    100% {
      background-color: rgb(10 2 3 / 0.72);
    }
    50% {
      background-color: rgb(46 6 10 / 0.82);
    }
  }

  @keyframes danger-shake-in {
    0% {
      transform: scale(0.94) translateY(14px);
    }
    20% {
      transform: scale(1.02) translateY(-6px) rotate(-1.2deg);
    }
    34% {
      transform: translateY(4px) rotate(1deg);
    }
    48% {
      transform: translateY(-2px) rotate(-0.5deg);
    }
    62% {
      transform: translateY(1px) rotate(0.3deg);
    }
    100% {
      transform: none;
    }
  }

  @keyframes danger-glow {
    0%,
    100% {
      box-shadow:
        0 24px 80px rgb(0 0 0 / 0.6),
        0 0 0 0 rgb(255 59 59 / 0.4);
    }
    50% {
      box-shadow:
        0 24px 80px rgb(0 0 0 / 0.6),
        0 0 34px 6px rgb(255 59 59 / 0.34);
    }
  }

  @keyframes danger-title-flash {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.72;
    }
  }

  @keyframes danger-heartbeat {
    0%,
    100% {
      transform: scale(1);
    }
    14% {
      transform: scale(1.16);
    }
    28% {
      transform: scale(1.02);
    }
    42% {
      transform: scale(1.12);
    }
  }

  @keyframes danger-count-pulse {
    0%,
    100% {
      color: var(--color-nc-txt);
      background-color: rgb(255 59 59 / 0.08);
    }
    50% {
      color: var(--color-nc-red);
      background-color: rgb(255 59 59 / 0.22);
    }
  }

  @keyframes danger-slow-blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.55;
    }
  }

  @keyframes hazard-crawl {
    from {
      background-position: 0 0;
    }
    to {
      background-position: 34px 0;
    }
  }

  /* Motion-sensitive users get the warning without the siren. */
  @media (prefers-reduced-motion: reduce) {
    .danger-scrim,
    .danger-card,
    .danger-title,
    .danger-icon,
    .danger-count,
    .danger-slow,
    .hazard-stripes {
      animation: none;
    }
  }
</style>
