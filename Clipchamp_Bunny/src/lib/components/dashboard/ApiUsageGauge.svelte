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
   * Honesty rules kept here:
   *   · `-1` means "the provider publishes no such limit" (Gemini sends no
   *     quota headers at all) and renders as `—`, never as an empty ring.
   *   · No daemon, or a daemon too old for `GET /v1/usage`, renders "no data"
   *     rather than a confident zero.
   *   · The fill is animated, not instant: the ring eases into a new value so
   *     a limit creeping upward is visible instead of a jump cut.
   */
  import { i18n } from '../../stores/i18n.svelte';
  import {
    saveApiKey,
    deleteApiKey,
    fetchUsageState,
    type UsageResponse,
    type KeyState
  } from '../../cloud';

  /* ------------------------------------------------------------- live data */

  let usage = $state<UsageResponse | null>(null);
  /** 'ok' | 'outdated' (daemon older than this endpoint) | 'down' */
  let link = $state<'loading' | 'ok' | 'outdated' | 'down'>('loading');
  let loading = $state(true);
  let open = $state(false);
  let tab = $state<'limits' | 'usage' | 'keys'>('limits');

  // Poll while this card is on screen, and harder while the panel is open —
  // 8 s of a ~2 kB loopback response is nothing, a websocket for a gauge
  // would be. The effect (not onMount) is what makes "harder while open"
  // true: an interval built once in onMount would read `open` exactly once
  // and then poll at that first rate forever. Re-running also means opening
  // the panel answers immediately instead of after up to 8 s.
  $effect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), open ? 4000 : 8000);
    return () => clearInterval(id);
  });

  async function refresh(): Promise<void> {
    const res = await fetchUsageState();
    link = res.state;
    if (res.state === 'ok') usage = res.usage;
    loading = false;
  }

  const groq = $derived(usage?.services?.['groq'] ?? null);
  const gemini = $derived(usage?.services?.['gemini'] ?? null);
  const keys = $derived<KeyState[]>(usage?.keys ?? []);

  /** -1 (provider says nothing) and missing both draw `—`, never `0%`. */
  const dayPct = $derived(groq?.requestsUsedPct ?? -1);
  const tokenPct = $derived(groq?.tokensUsedPct ?? -1);
  const hasData = $derived(!!usage && (groq?.calls ?? 0) + (gemini?.calls ?? 0) > 0);

  const outerColor = $derived(
    dayPct < 0
      ? 'text-nc-mut'
      : dayPct >= 85
        ? 'text-nc-red'
        : dayPct >= 60
          ? 'text-nc-gold'
          : 'text-nc-brand'
  );

  /* -------------------------------------------------------------- geometry */

  const R_OUTER = 84;
  const R_INNER = 66;
  const C_OUTER = 2 * Math.PI * R_OUTER;
  const C_INNER = 2 * Math.PI * R_INNER;

  /** A ring at 0% is fully hidden; -1 draws nothing at all. */
  function offset(circumference: number, pct: number): number {
    if (pct < 0) return circumference;
    return circumference * (1 - Math.min(100, pct) / 100);
  }

  /* ------------------------------------------------------------------ keys */

  let draft = $state<Record<string, string>>({});
  let keyMsg = $state<{ ok: boolean; text: string } | null>(null);
  let busy = $state<string | null>(null);

  async function save(service: 'groq' | 'gemini'): Promise<void> {
    const key = (draft[service] ?? '').trim();
    if (!key || busy) return;
    busy = service;
    keyMsg = null;
    const res = await saveApiKey(service, key);
    busy = null;
    if (res.ok) {
      draft = { ...draft, [service]: '' };
      keyMsg = { ok: true, text: i18n.t('usage.keySaved') };
      await refresh();
    } else {
      keyMsg = {
        ok: false,
        text: res.detail === 'unavailable' ? i18n.t('usage.daemonDown') : res.detail
      };
    }
  }

  async function remove(service: 'groq' | 'gemini'): Promise<void> {
    if (busy) return;
    busy = service;
    keyMsg = null;
    const res = await deleteApiKey(service);
    busy = null;
    if (res.ok) {
      keyMsg = { ok: true, text: i18n.t('usage.keyRemoved') };
      await refresh();
    } else {
      keyMsg = { ok: false, text: i18n.t('usage.keySaveFailed') };
    }
  }

  /* --------------------------------------------------------------- helpers */

  const num = (n: number | undefined): string =>
    n === undefined || n === null ? '—' : new Intl.NumberFormat().format(n);

  const pct = (n: number): string => (n < 0 ? '—' : `${Math.round(n)}%`);

  function timeAgo(iso?: string): string {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return '—';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }

  /** Groq's free-plan numbers, quoted from console.groq.com/docs/rate-limits. */
  const GROQ_PLAN = [
    { model: 'openai/gpt-oss-120b', rpm: '30', rpd: '1,000', tpm: '8,000' },
    { model: 'whisper-large-v3', rpm: '20', rpd: '2,000', tpm: '—' }
  ];
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
    onclick={() => (open = true)}
    aria-label={i18n.t('usage.open')}
    class="mt-3 flex w-full items-center gap-4 rounded-lg px-1 py-1 text-left
           transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-nc-brand/60"
  >
    <span class="relative block h-[168px] w-[168px] shrink-0 {outerColor}">
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
          stroke-dashoffset={offset(C_INNER, tokenPct)}
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
          stroke-dashoffset={offset(C_OUTER, dayPct)}
        />
      </svg>

      <span class="pointer-events-none absolute inset-0 grid place-content-center text-center">
        <span class="text-[30px] leading-none font-bold text-nc-txt tabular-nums"
          >{pct(dayPct)}</span
        >
        <span class="mt-1.5 text-[11px] text-nc-mut">{i18n.t('usage.ringRequests')}</span>
        <span class="mt-0.5 text-[10.5px] text-nc-mut-2 tabular-nums">
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

<!-- ── the details panel ───────────────────────────────────────────────── -->
{#if open}
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6 backdrop-blur-sm"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) open = false;
    }}
    onkeydown={(e) => {
      if (e.key === 'Escape') open = false;
    }}
  >
    <div
      class="t9-card-in flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl
             border border-nc-line bg-nc-panel/95 backdrop-blur-xl"
      role="dialog"
      aria-modal="true"
      aria-label={i18n.t('usage.title')}
    >
      <!-- header -->
      <header class="flex items-center gap-3 border-b border-nc-line px-5 py-4">
        <h2 class="flex-1 text-[15px] font-semibold text-nc-txt">{i18n.t('usage.title')}</h2>
        <span class="text-[11px] text-nc-mut-2 tabular-nums">
          {usage ? i18n.t('usage.updated', { t: timeAgo(usage.updatedAt) }) : '—'}
        </span>
        <button
          type="button"
          onclick={() => (open = false)}
          aria-label={i18n.t('usage.close')}
          class="grid h-8 w-8 place-items-center rounded-lg border border-nc-line bg-nc-panel-2
                 text-nc-mut transition-colors hover:text-nc-txt"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <!-- tabs -->
      <nav class="flex gap-1 border-b border-nc-line px-4 pt-3">
        {#each ['limits', 'usage', 'keys'] as id (id)}
          <button
            type="button"
            onclick={() => (tab = id as typeof tab)}
            class="rounded-t-lg px-3.5 pb-2.5 text-[12.5px] font-medium transition-colors
                   {tab === id
              ? 'border-b-2 border-nc-brand text-nc-txt'
              : 'border-b-2 border-transparent text-nc-mut hover:text-nc-txt'}"
          >
            {i18n.t(`usage.tab${id.charAt(0).toUpperCase() + id.slice(1)}`)}
          </button>
        {/each}
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {#if link === 'outdated'}
          <p class="text-[13px] text-nc-mut">{i18n.t('usage.outdated')}</p>
        {:else if !usage}
          <p class="text-[13px] text-nc-mut">{i18n.t('usage.daemonDown')}</p>

          <!-- ─────────────────────────── limits ─────────────────────────── -->
        {:else if tab === 'limits'}
          <div class="space-y-4">
            <!-- Groq: measured, not published -->
            <div class="rounded-xl border border-nc-line bg-nc-panel-2/60 p-4">
              <div class="flex items-center gap-2">
                <span class="text-[13px] font-semibold text-nc-txt">Groq</span>
                <span class="text-[11px] text-nc-green">{i18n.t('usage.live')}</span>
              </div>

              {#if groq?.rateLimit}
                <div class="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <div class="text-[11px] text-nc-mut-2">{i18n.t('usage.reqDay')}</div>
                    <div class="text-[15px] font-semibold text-nc-txt tabular-nums">
                      {num(groq.rateLimit.requestsLimit)} · {i18n.t('usage.left')}
                      {num(groq.rateLimit.requestsRemaining)}
                    </div>
                    <div class="text-[11px] text-nc-mut-2">
                      {i18n.t('usage.used')}
                      {pct(groq.requestsUsedPct)}
                      {#if groq.rateLimit.requestsReset}· {groq.rateLimit.requestsReset}{/if}
                    </div>
                  </div>
                  <div>
                    <div class="text-[11px] text-nc-mut-2">{i18n.t('usage.tokMin')}</div>
                    <div class="text-[15px] font-semibold text-nc-txt tabular-nums">
                      {num(groq.rateLimit.tokensLimit)} · {i18n.t('usage.left')}
                      {num(groq.rateLimit.tokensRemaining)}
                    </div>
                    <div class="text-[11px] text-nc-mut-2">
                      {i18n.t('usage.used')}
                      {pct(groq.tokensUsedPct)}
                      {#if groq.rateLimit.tokensReset}· {groq.rateLimit.tokensReset}{/if}
                    </div>
                  </div>
                </div>
                <p class="mt-3 text-[11.5px] leading-relaxed text-nc-mut-2">
                  {i18n.t('usage.headerNote')}
                </p>
              {:else}
                <p class="mt-2 text-[12px] leading-relaxed text-nc-mut">
                  {i18n.t('usage.standbyNote')}
                </p>
              {/if}

              <table class="mt-3 w-full border-collapse text-[11.5px]">
                <thead>
                  <tr class="text-left text-nc-mut-2">
                    <th class="pb-1 font-medium">{i18n.t('usage.model')}</th>
                    <th class="pb-1 font-medium">RPM</th>
                    <th class="pb-1 font-medium">RPD</th>
                    <th class="pb-1 font-medium">TPM</th>
                  </tr>
                </thead>
                <tbody class="text-nc-mut tabular-nums">
                  {#each GROQ_PLAN as row (row.model)}
                    <tr class="border-t border-nc-line/70">
                      <td class="py-1 pr-2 font-mono text-[11px] text-nc-txt">{row.model}</td>
                      <td class="py-1">{row.rpm}</td>
                      <td class="py-1">{row.rpd}</td>
                      <td class="py-1">{row.tpm}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <p class="mt-2 text-[11px] text-nc-mut-2">{i18n.t('usage.planNote')}</p>
            </div>

            <!-- Gemini: measured usage, no published headers -->
            <div class="rounded-xl border border-nc-line bg-nc-panel-2/60 p-4">
              <div class="flex items-center gap-2">
                <span class="text-[13px] font-semibold text-nc-txt">Gemini</span>
                <span class="text-[11px] text-nc-gold">{i18n.t('usage.notPublished')}</span>
              </div>
              <p class="mt-2 text-[12px] leading-relaxed text-nc-mut">
                {i18n.t('usage.geminiNote')}
              </p>
              <div class="mt-3 grid grid-cols-3 gap-3">
                <div>
                  <div class="text-[11px] text-nc-mut-2">{i18n.t('usage.today')}</div>
                  <div class="text-[15px] font-semibold text-nc-txt tabular-nums">
                    {num(gemini?.today?.calls ?? 0)}
                  </div>
                </div>
                <div>
                  <div class="text-[11px] text-nc-mut-2">{i18n.t('usage.tokensOut')}</div>
                  <div class="text-[15px] font-semibold text-nc-txt tabular-nums">
                    {num(gemini?.today?.tokensOut ?? 0)}
                  </div>
                </div>
                <div>
                  <div class="text-[11px] text-nc-mut-2">{i18n.t('usage.latency')}</div>
                  <div class="text-[15px] font-semibold text-nc-txt tabular-nums">
                    {gemini ? `${num(gemini.avgLatencyMs)} ms` : '—'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- ─────────────────────────── usage ─────────────────────────── -->
        {:else if tab === 'usage'}
          <div class="space-y-4">
            {#each ['groq', 'gemini'] as svc (svc)}
              {@const u = usage.services[svc] ?? null}
              <div class="rounded-xl border border-nc-line bg-nc-panel-2/60 p-4">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-semibold text-nc-txt capitalize">{svc}</span>
                  <span class="ml-auto text-[11px] text-nc-mut-2">
                    {i18n.t('usage.lastCall')}
                    {timeAgo(u?.lastCall)}
                  </span>
                </div>

                <div class="mt-3 grid grid-cols-3 gap-3">
                  <div>
                    <div class="text-[11px] text-nc-mut-2">{i18n.t('usage.today')}</div>
                    <div class="text-[15px] font-semibold text-nc-txt tabular-nums">
                      {num(u?.today?.calls ?? 0)}
                    </div>
                  </div>
                  <div>
                    <div class="text-[11px] text-nc-mut-2">{i18n.t('usage.lifetime')}</div>
                    <div class="text-[15px] font-semibold text-nc-txt tabular-nums">
                      {num(u?.calls ?? 0)}
                    </div>
                  </div>
                  <div>
                    <div class="text-[11px] text-nc-mut-2">{i18n.t('usage.tokensOut')}</div>
                    <div class="text-[15px] font-semibold text-nc-txt tabular-nums">
                      {num(u?.tokensOut ?? 0)}
                    </div>
                  </div>
                </div>

                <div class="mt-3 grid grid-cols-4 gap-2 border-t border-nc-line/70 pt-3">
                  {#each [['avg', u?.avgLatencyMs], ['p50', u?.p50LatencyMs], ['p95', u?.p95LatencyMs], ['max', u?.maxLatencyMs]] as [string, number | undefined][] as [label, value] (label)}
                    <div>
                      <div class="text-[11px] text-nc-mut-2">{label}</div>
                      <div class="text-[13px] font-medium text-nc-txt tabular-nums">
                        {num(value)} ms
                      </div>
                    </div>
                  {/each}
                </div>

                <div class="mt-3 flex gap-4 border-t border-nc-line/70 pt-3 text-[12px]">
                  <span class="text-nc-mut">
                    {i18n.t('usage.errors')}
                    <span class="ml-1 font-semibold text-nc-txt tabular-nums"
                      >{num(u?.errors ?? 0)}</span
                    >
                  </span>
                  <span class="text-nc-mut">
                    429 <span class="ml-1 font-semibold text-nc-txt tabular-nums"
                      >{num(u?.rateLimited ?? 0)}</span
                    >
                  </span>
                </div>

                {#if u?.lastError}
                  <p class="mt-2 truncate text-[11.5px] text-nc-red" title={u.lastError}>
                    {u.lastError}
                  </p>
                {/if}
              </div>
            {/each}

            <div>
              <h3 class="mb-2 text-[12.5px] font-medium text-nc-mut">{i18n.t('usage.recent')}</h3>
              {#if usage.recent.length === 0}
                <p class="text-[12px] text-nc-mut-2">{i18n.t('usage.recentEmpty')}</p>
              {:else}
                <ul class="space-y-1">
                  {#each usage.recent.slice(-8).reverse() as call, i (i + call.at + call.service)}
                    <li class="flex items-center gap-3 text-[11.5px] text-nc-mut tabular-nums">
                      <span class="w-16 shrink-0 text-nc-mut-2">{timeAgo(call.at)}</span>
                      <span class="w-14 shrink-0 capitalize">{call.service}</span>
                      <span
                        class="w-10 shrink-0 {call.status >= 400 || call.err
                          ? 'text-nc-red'
                          : 'text-nc-green'}">{call.status || 'net'}</span
                      >
                      <span class="w-16 shrink-0 text-right">{call.latencyMs} ms</span>
                      <span class="shrink-0">{call.tokensIn}→{call.tokensOut} tok</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          </div>

          <!-- ─────────────────────────── keys ─────────────────────────── -->
        {:else}
          <div class="space-y-4">
            <p class="text-[12px] leading-relaxed text-nc-mut">{i18n.t('usage.keyIntro')}</p>

            {#each ['groq', 'gemini'] as svc (svc)}
              {@const k = keys.find((x) => x.service === svc) ?? null}
              <div class="rounded-xl border border-nc-line bg-nc-panel-2/60 p-4">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-semibold text-nc-txt capitalize">{svc}</span>
                  <span
                    class="rounded-full px-2 py-0.5 text-[10.5px] font-medium
                           {k?.configured
                      ? 'bg-nc-green/15 text-nc-green'
                      : 'bg-nc-mut/10 text-nc-mut'}"
                  >
                    {i18n.t(k?.configured ? 'cloud.connected' : 'cloud.notConnected')}
                  </span>
                  {#if k?.configured}
                    <span class="ml-auto font-mono text-[11.5px] text-nc-mut-2">{k.masked}</span>
                  {/if}
                </div>

                {#if k?.configured}
                  <p class="mt-1.5 text-[11.5px] text-nc-mut-2">
                    {k.model}{#if k.chatModel}{` · ${k.chatModel}`}{/if}
                  </p>
                {/if}

                <div class="mt-3 flex gap-2">
                  <input
                    type="password"
                    bind:value={draft[svc]}
                    placeholder={i18n.t('usage.keyPlaceholder')}
                    autocomplete="off"
                    spellcheck="false"
                    aria-label={i18n.t('usage.keyPlaceholder')}
                    class="min-w-0 flex-1 rounded-lg border border-nc-line bg-nc-bg/70 px-3 py-2 text-[12.5px]
                           text-nc-txt placeholder:text-nc-mut-2 focus:border-nc-brand/60 focus:outline-none"
                  />
                  <button
                    type="button"
                    onclick={() => void save(svc as 'groq' | 'gemini')}
                    disabled={busy !== null || !(draft[svc] ?? '').trim()}
                    class="shrink-0 rounded-lg border border-nc-brand/50 bg-nc-brand/10 px-3 text-[12.5px]
                           font-medium text-nc-brand transition-[filter,background-color] duration-150
                           hover:bg-nc-brand/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy === svc ? '…' : i18n.t('usage.keySave')}
                  </button>
                  {#if k?.configured}
                    <button
                      type="button"
                      onclick={() => void remove(svc as 'groq' | 'gemini')}
                      disabled={busy !== null}
                      class="shrink-0 rounded-lg border border-nc-line bg-nc-panel-2 px-3 text-[12.5px]
                             font-medium text-nc-mut transition-colors hover:border-nc-red/50
                             hover:text-nc-red disabled:opacity-40"
                    >
                      {i18n.t('usage.keyRemove')}
                    </button>
                  {/if}
                </div>
              </div>
            {/each}

            {#if keyMsg}
              <p class="text-[12px] {keyMsg.ok ? 'text-nc-green' : 'text-nc-red'}">{keyMsg.text}</p>
            {/if}

            <p class="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-nc-mut-2">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                class="mt-px shrink-0"
                aria-hidden="true"
              >
                <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
              </svg>
              <span>
                {i18n.t('usage.keyStorage')}
                {#if usage.overlayPath}
                  <span class="font-mono">{usage.overlayPath}</span>
                {/if}
              </span>
            </p>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
