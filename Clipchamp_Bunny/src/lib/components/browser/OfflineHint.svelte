<script lang="ts">
  /**
   * The dial's "internet is off" animation — bottom-right of the browser's
   * home page, half the dial's width (330px of its 660), stuck to the bottom
   * edge, and deliberately WITHOUT text: "home page browser me right bottom
   * me animation no text jisse user samajh jaye ki internet band h".
   *
   * It is a crossed wifi glyph whose arcs keep TRYING to light up while a
   * packet rises from the dot and dies before reaching them — motion that
   * reads as "signal, but it isn't reaching" at a glance. Chromium's own
   * offline page still handles a real navigation ("baki toh edge ka by
   * default sambhal hi lega"); this only exists so the user knows *before*
   * they click a tile.
   *
   * Detection is `navigator.onLine` plus the `online`/`offline` events —
   * exactly what the platform reports when the user has not turned the
   * internet on. It renders only inside the speed dial (a blank tab), which
   * is plain DOM: no native webview can paint over it there.
   */
  import { onMount } from 'svelte';

  let online = $state(true);

  onMount(() => {
    online = navigator.onLine;
    const up = () => (online = true);
    const down = () => (online = false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  });
</script>

{#if !online}
  <div
    class="pointer-events-none absolute right-6 bottom-0 z-10 w-[330px] max-w-[45vw] select-none text-nc-mut"
    aria-hidden="true"
  >
    <svg viewBox="0 0 330 120" class="h-auto w-full" fill="none" stroke="currentColor">
      <!-- the ground the scene is stuck to: the bottom edge, not floating -->
      <path d="M8 111h314" stroke-width="2" stroke-opacity="0.3" stroke-linecap="round" />

      <!-- the glyph: dot + three arcs, opening upward, crossed out -->
      <circle cx="165" cy="79" r="7" fill="currentColor" stroke="none" />
      <path class="off-arc off-arc-1" d="M149 63a16 16 0 0 1 32 0" stroke-width="6" />
      <path class="off-arc off-arc-2" d="M131 63a34 34 0 0 1 68 0" stroke-width="6.5" />
      <path class="off-arc off-arc-3" d="M113 63a52 52 0 0 1 104 0" stroke-width="7" />

      <!-- the packet: leaves the dot, fades out before the arcs — "trying" -->
      <circle class="off-packet" cx="165" cy="72" r="4.5" fill="currentColor" stroke="none" />

      <!-- the slash: this is OFF, not merely quiet -->
      <path
        class="off-slash text-nc-red"
        d="M124 20l84 84"
        stroke="currentColor"
        stroke-width="7"
        stroke-linecap="round"
      />
    </svg>
  </div>
{/if}

<style>
  /*
   * One 2.6 s loop: the arcs light from the dot outward (inner first, 350 ms
   * apart) as the packet climbs and dies, then the slash breathes once. The
   * whole thing says "trying to connect, not connecting" without a word.
   */
  @keyframes t9-off-wave {
    0%,
    100% {
      opacity: 0.16;
    }
    35% {
      opacity: 0.95;
    }
    60% {
      opacity: 0.16;
    }
  }

  .off-arc {
    animation: t9-off-wave 2.6s ease-in-out infinite;
  }

  .off-arc-1 {
    animation-delay: 0s;
  }

  .off-arc-2 {
    animation-delay: 0.35s;
  }

  .off-arc-3 {
    animation-delay: 0.7s;
  }

  @keyframes t9-off-packet {
    0% {
      transform: translateY(0);
      opacity: 0;
    }
    15% {
      opacity: 1;
    }
    70% {
      transform: translateY(-46px);
      opacity: 0;
    }
    100% {
      transform: translateY(-46px);
      opacity: 0;
    }
  }

  /* Base opacity 0 so reduced motion hides it instead of parking a blue dot
     on top of the glyph's own dot. */
  .off-packet {
    opacity: 0;
    animation: t9-off-packet 2.6s ease-out infinite;
  }

  @keyframes t9-off-slash {
    0%,
    100% {
      opacity: 0.8;
    }
    50% {
      opacity: 1;
    }
  }

  .off-slash {
    animation: t9-off-slash 2.6s ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .off-arc,
    .off-packet,
    .off-slash {
      animation: none;
    }
  }
</style>
