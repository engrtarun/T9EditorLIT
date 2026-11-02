<script lang="ts">
  /**
   * THE API GAUGE — the circle on the right of the T9 Cloud panel.
   *
   * It answers three questions the rest of the page only gestures at:
   *
   *   1. **How full is the limit right now?** The outer ring is Groq's
   *      *requests-per-day* bucket, read from the `x-ratelimit-limit-requests`
   *      header on the daemon's real calls — it fills slowly across a working
   *      day and resets when Groq says it does. The inner ring is the
   *      *tokens-per-minute* bucket, which is fast and jumpy on purpose.
   *      Groq documents both meanings; nothing here is estimated.
   *   2. **What did it cost?** Click → Usage tab: calls, tokens, latency
   *      percentiles and every 429 the daemon actually saw.
   *   3. **Who owns the credential?** Click → API keys tab: add, replace or
   *      remove a key. The daemon never returns a full key, only `masked`.
   *
   * The dialog itself moved to `UsageDialog.svelte` — the editor's tool row
   * opens the same panel, and a component only mounted on this screen could
   * not serve both. What stays here is the card: one 112px ring, the text
   * beside it, and a click through to the shared panel.
   *
   * Honesty rules kept here:
   *   · `-1` means "the provider publishes no such limit" (Gemini sends no
   *     quota headers at all) and renders `—`, never as an empty ring.
   *   · No daemon, or a daemon too old for `GET /v1/usage`, renders "no data"
   *     rather than a confident zero.
   *   · The fill is animated, not instant: the ring eases into a new value so
   *     a limit creeping upward is visible instead of a jump cut.
   */
  import { i18n } from '../../stores/i18n.svelte';
  import { usageStore } from '../../usage-store.svelte';
  import {
    C_INNER,
    C_OUTER,
    R_INNER,
    R_OUTER,
    num,
    pct,
    ringColor,
    ringOffset,
    timeAgo
  } from '../../usage-format';

  /* Poll while this card is on screen. `attach` re-reads the store's `open`,
     so opening the panel steps this from 8 s to 4 s — the effect re-runs and
     re-arms the interval, which an interval built once never could. */
  $effect(() => usageStore.attach());

  const usage = $derived(usageStore.usage);
  const link = $derived(usageStore.link);
  const loading = $derived(usageStore.loading);
  const groq = $derived(usageStore.groq);
  const gemini = $derived(usageStore.gemini);
  const dayPct = $derived(usageStore.dayPct);
  const tokenPct = $derived(usageStore.tokenPct);
  const hasData = $derived(usageStore.hasData);
  const outerColor = $derived(ringColor(dayPct));
</script>

<!-- ── the gauge ───────────────────────────────────────────────────────── -->
<div
  class="t9-card-in group w-full shrink-0 rounded-xl border border-nc-line bg-nc-panel/70 p-4
         backdrop-blur-md transition-[border-color] duration-150 hover:border-nc-line-2"
  style="--i:4"
>
  <div class="flex items-center justify-between gap-3">
    <h3 class="text-[14px] font-semibold text-nc-txt">{i18n.t('usage.title')}</h3>
    <span
      class="t9-spin h-3 w-3 rounded-full border-[1.5px] border-nc-brand/30 border-t-nc-brand"
      class:opacity-0={!loading}
      aria-hidden="true"
    ></span>
  </div>

  <button
    type="button"
    onclick={() => usageStore.openDialog()}
    aria-label={i18n.t('usage.open')}
    class="mt-3 flex w-full items-center gap-4 rounded-lg px-1 py-1 text-left
           transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-nc-brand/60"
  >
    <!-- 112px, down from 168: the ring used to eat the column, squeezing the
         three lines beside it until they wrapped. The viewBox stays 200, so
         both rings and their strokes scale with the box. -->
    <span class="relative block h-[112px] w-[112px] shrink-0 {outerColor}">
      <svg viewBox="0 0 200 200" class="h-full w-full -rotate-90" aria-hidden="true">
        <!-- outer track: requests per day (the slow one) -->
        <circle
          cx="100"
          cy="100"
          r={R_OUTER}
          class="fill-none stroke-nc-panel-2"
          stroke-width="10"
        />
        <!-- inner track: tokens per minute (the fast one) -->
        <circle
          cx="100"
          cy="100"
          r={R_INNER}
          class="fill-none stroke-nc-panel-2"
          stroke-width="6"
        />

        <!-- the fill. The dashoffset eases into place over 1.4 s, so a limit
             creeping toward full is something you can watch happen. -->
        <circle
          cx="100"
          cy="100"
          r={R_INNER}
          class="fill-none stroke-nc-mut-2 transition-[stroke-dashoffset] duration-1000 ease-out"
          stroke-width="6"
          stroke-linecap="round"
          stroke-dasharray={C_INNER}
          stroke-dashoffset={ringOffset(C_INNER, tokenPct)}
        />
        <circle
          cx="100"
          cy="100"
          r={R_OUTER}
          class="fill-none transition-[stroke-dashoffset,stroke] duration-[1400ms] ease-out"
          stroke="currentColor"
          stroke-width="10"
          stroke-linecap="round"
          stroke-dasharray={C_OUTER}
          stroke-dashoffset={ringOffset(C_OUTER, dayPct)}
        />
      </svg>

      <span class="pointer-events-none absolute inset-0 grid place-content-center text-center">
        <span class="text-[22px] leading-none font-bold text-nc-txt tabular-nums"
          >{pct(dayPct)}</span
        >
        <span class="mt-1 text-[10px] text-nc-mut">{i18n.t('usage.ringRequests')}</span>
        <span class="mt-0.5 text-[9.5px] text-nc-mut-2 tabular-nums">
          {i18n.t('usage.ringTokens')}
          {pct(tokenPct)}
        </span>
      </span>
    </span>

    <span class="min-w-0 flex-1">
      {#if link === 'outdated'}
        <span class="block text-[12.5px] leading-relaxed text-nc-mut"
          >{i18n.t('usage.outdated')}</span
        >
      {:else if !usage}
        <span class="block text-[12.5px] leading-relaxed text-nc-mut"
          >{i18n.t('usage.daemonDown')}</span
        >
      {:else if !hasData}
        <span class="block text-[12.5px] leading-relaxed text-nc-mut">{i18n.t('usage.noData')}</span
        >
      {:else}
        <span class="block text-[12.5px] leading-relaxed text-nc-mut">
          {i18n.t('usage.blurb', { calls: num((groq?.calls ?? 0) + (gemini?.calls ?? 0)) })}
        </span>
        <span class="mt-2 block text-[11.5px] text-nc-mut-2">
          {i18n.t('usage.lastCall')}
          {timeAgo(groq?.lastCall ?? gemini?.lastCall)}
        </span>
        <span class="mt-1 block text-[11.5px] text-nc-mut-2">
          {i18n.t('usage.clickFor')} →
        </span>
      {/if}
    </span>
  </button>
</div>
