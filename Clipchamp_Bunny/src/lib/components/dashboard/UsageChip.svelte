<script lang="ts">
  /**
   * THE QUOTA CHIP — the same two rings, shrunk to fit a 30px tool row.
   *
   * It exists because the editor is where quota actually gets spent: a
   * transcription, an autocorrect pass or an analysis run happens mid-cut,
   * and walking back to the T9 Cloud screen to see what is left is a detour
   * the user should not have to make. Placed beside the colour-key legend,
   * it is one glance from the buttons being pressed.
   *
   * It shows numbers and opens the shared panel; it never re-implements the
   * dialog, and never polls on its own — `usageStore.attach()` gives it the
   * same interval every other surface uses, refcounted so only one runs.
   *
   * `-1` (a provider that publishes no quota, or no call yet) renders `—`,
   * never a confident `0%`.
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

  $effect(() => usageStore.attach());

  const link = $derived(usageStore.link);
  const usage = $derived(usageStore.usage);
  const groq = $derived(usageStore.groq);
  const gemini = $derived(usageStore.gemini);
  const dayPct = $derived(usageStore.dayPct);
  const tokenPct = $derived(usageStore.tokenPct);
  const hasData = $derived(usageStore.hasData);
  const outerColor = $derived(ringColor(dayPct));

  /** The chip carries no text of its own beyond the two percentages, so the
   *  tooltip has to say everything the dialog would: what is left, when the
   *  last call was, and that there is more behind the click. */
  const tip = $derived.by(() => {
    if (link === 'outdated') return i18n.t('usage.outdated');
    if (!usage) return i18n.t('usage.daemonDown');
    if (!hasData) return i18n.t('usage.noData');
    const rl = groq?.rateLimit;
    const parts = [
      `${i18n.t('usage.ringRequests')} ${pct(dayPct)}` +
        (rl
          ? ` (${num(rl.requestsLimit)} · ${i18n.t('usage.left')} ${num(rl.requestsRemaining)})`
          : ''),
      `${i18n.t('usage.ringTokens')} ${pct(tokenPct)}` +
        (rl
          ? ` (${num(rl.tokensLimit)} · ${i18n.t('usage.left')} ${num(rl.tokensRemaining)})`
          : ''),
      `${i18n.t('usage.lastCall')} ${timeAgo(groq?.lastCall ?? gemini?.lastCall)}`
    ];
    return `${parts.join(' · ')} — ${i18n.t('usage.clickFor')}`;
  });

  const dim = $derived(link === 'outdated' || !usage || !hasData);
</script>

<button
  type="button"
  onclick={() => usageStore.openDialog()}
  title={tip}
  aria-label={`${i18n.t('usage.open')} — ${tip}`}
  class="flex h-[22px] shrink-0 items-center gap-1 rounded-md border border-nc-line/70
         bg-nc-panel-2/60 px-1.5 text-[9px] text-nc-mut transition-colors
         hover:border-nc-line-2 hover:text-nc-txt focus:outline-none
         focus-visible:ring-1 focus-visible:ring-nc-brand/60"
>
  <span class="relative block h-[16px] w-[16px] shrink-0 {dim ? 'text-nc-mut' : outerColor}">
    <!-- Same 200 viewBox as the big ring, but thicker strokes: at 16px a
         10-unit stroke would render under a pixel and disappear. -->
    <svg viewBox="0 0 200 200" class="h-full w-full -rotate-90" aria-hidden="true">
      <circle cx="100" cy="100" r={R_OUTER} class="fill-none stroke-nc-line" stroke-width="26" />
      <circle cx="100" cy="100" r={R_INNER} class="fill-none stroke-nc-line" stroke-width="16" />
      <circle
        cx="100"
        cy="100"
        r={R_INNER}
        class="fill-none stroke-nc-mut-2"
        stroke-width="16"
        stroke-linecap="round"
        stroke-dasharray={C_INNER}
        stroke-dashoffset={ringOffset(C_INNER, tokenPct)}
      />
      <circle
        cx="100"
        cy="100"
        r={R_OUTER}
        class="fill-none"
        stroke="currentColor"
        stroke-width="26"
        stroke-linecap="round"
        stroke-dasharray={C_OUTER}
        stroke-dashoffset={ringOffset(C_OUTER, dayPct)}
      />
    </svg>
  </span>
  <span class="tabular-nums">{pct(dayPct)}</span>
  <span class="text-nc-mut-2 tabular-nums">{pct(tokenPct)}</span>
</button>
