<script lang="ts">
  /**
   * THE DETAILS PANEL — opened from either usage surface.
   *
   * It used to live inside the gauge card, which meant only the T9 Cloud
   * screen could ever show it: the editor's tool row has no copy of that
   * card, and mode isolation unmounts it anyway. Living at the app root
   * instead, one instance serves both triggers and one poll feeds both.
   *
   * Honesty rules carried over unchanged:
   *   · `-1` means "the provider publishes no such limit" and renders `—`.
   *   · No daemon, or a daemon too old for `GET /v1/usage`, says so rather
   *     than inventing a zero.
   *   · Keys are ever shown masked — the daemon never returns a full one.
   */
  import { i18n } from '../../stores/i18n.svelte';
  import { saveApiKey, deleteApiKey, fetchElevenKeys, type ElevenKeyStatus } from '../../cloud';
  import { ingestApiCalls, fetchUsageTimeline, fetchUsageCalls } from '../../ipc';
  import type { ApiCallRow, UsageDayRow } from '../../types';
  import { usageStore, type UsageTab } from '../../usage-store.svelte';
  import { num, pct, timeAgo } from '../../usage-format';

  /* Store reads are derived so the markup below stays reactive while the
     store itself stays the only writer. */
  const usage = $derived(usageStore.usage);
  const link = $derived(usageStore.link);
  const groq = $derived(usageStore.groq);
  const gemini = $derived(usageStore.gemini);
  const keys = $derived(usageStore.keys);
  const tab = $derived(usageStore.tab);
  const open = $derived(usageStore.open);
  /* Every engine the recorder has actually seen, primary first — a new
     service shows up here without anyone editing this file again. */
  const serviceList = $derived(
    ['elevenlabs', 'groq', 'gemini'].filter((s) => usage?.services?.[s] != null)
  );

  /* --------------------------------------------------------------- keys */

  let draft = $state<Record<string, string>>({});
  let keyMsg = $state<{ ok: boolean; text: string } | null>(null);
  let busy = $state<string | null>(null);

  /* ------------------------------------------------------- eleven pool */
  /* The primary engine's real monthly quota lives in the pool, not in
     `usage.services` — the recorder only sees headers, and Scribe sends
     none. Read it once per open so the Limits tab can answer "11labs ka
     hissab" with the probe's numbers, per account. */
  let eleven = $state<ElevenKeyStatus[]>([]);
  let elevenSeen = $state(false);

  /* ------------------------------------------------------- history */
  let timeline = $state<UsageDayRow[]>([]);
  let calls = $state<ApiCallRow[]>([]);
  let historyService = $state('');
  let historyLoaded = $state(false);
  let historyBusy = $state(false);

  $effect(() => {
    if (!open || tab !== 'history' || historyLoaded || historyBusy) return;
    historyBusy = true;
    const cp = usage?.callsPath ?? '';
    void (async () => {
      if (cp) await ingestApiCalls(cp);
      const [t, c] = await Promise.all([
        fetchUsageTimeline(30),
        fetchUsageCalls(historyService, 100)
      ]);
      timeline = t;
      calls = c;
      historyLoaded = true;
      historyBusy = false;
    })();
  });

  $effect(() => {
    if (!open || tab !== 'history') return;
    // re-fetch calls when filter changes (after initial load)
    if (!historyLoaded) return;
    void fetchUsageCalls(historyService, 100).then((c) => (calls = c));
  });

  $effect(() => {
    if (!open || elevenSeen) return;
    elevenSeen = true;
    void fetchElevenKeys().then((r) => {
      if (r) eleven = r.keys;
    });
  });

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
      await usageStore.refresh();
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
      await usageStore.refresh();
    } else {
      keyMsg = { ok: false, text: i18n.t('usage.keySaveFailed') };
    }
  }

  /**
   * Keep the poll alive only while the panel is open. On a screen with no
   * usage surface mounted this is what still answers the dialog's own
   * refresh — and it re-reads `open`, so closing it hands polling back to
   * whichever surface is on screen.
   */
  $effect(() => {
    if (!usageStore.open) return;
    return usageStore.attach();
  });

  /* Groq's free-plan numbers, quoted from console.groq.com/docs/rate-limits. */
  const GROQ_PLAN = [
    { model: 'openai/gpt-oss-120b', rpm: '30', rpd: '1,000', tpm: '8,000' },
    { model: 'whisper-large-v3', rpm: '20', rpd: '2,000', tpm: '—' }
  ];
</script>

<!-- ── the details panel ───────────────────────────────────────────────── -->
{#if open}
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6 backdrop-blur-sm"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) usageStore.closeDialog();
    }}
    onkeydown={(e) => {
      if (e.key === 'Escape') usageStore.closeDialog();
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
          onclick={() => usageStore.closeDialog()}
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
        {#each ['limits', 'usage', 'history', 'keys'] as id (id)}
          <button
            type="button"
            onclick={() => (usageStore.tab = id as UsageTab)}
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
            <!-- ElevenLabs: the primary engine — one bar per account, because
                 the pool's quota is per free account, not one global number. -->
            <div class="rounded-xl border border-nc-line bg-nc-panel-2/60 p-4">
              <div class="flex items-center gap-2">
                <span class="text-[13px] font-semibold text-nc-txt">ElevenLabs</span>
                <span class="text-[11px] text-nc-green">{i18n.t('usage.primary')}</span>
                <span class="ml-auto text-[11px] text-nc-mut-2 tabular-nums">
                  {i18n.t('usage.accounts', { n: String(eleven.length) })}
                </span>
              </div>

              {#if eleven.length === 0}
                <p class="mt-2 text-[12px] leading-relaxed text-nc-mut">
                  {i18n.t('usage.elevenEmpty')}
                </p>
              {:else}
                <ul class="mt-3 space-y-3">
                  {#each eleven as k (k.id)}
                    {@const used =
                      k.quotaLimit != null && k.quotaLimit > 0
                        ? Math.min(100, Math.round(((k.quotaUsed ?? 0) / k.quotaLimit) * 100))
                        : -1}
                    <li>
                      <div class="flex items-baseline gap-2">
                        <span class="font-mono text-[11.5px] text-nc-txt">{k.masked}</span>
                        {#if k.tier}
                          <span class="text-[10.5px] text-nc-mut-2">{k.tier}</span>
                        {/if}
                        <span
                          class="ml-auto text-[10.5px]
                                 {k.state === 'ready'
                            ? 'text-nc-green'
                            : k.state === 'cooldown'
                              ? 'text-nc-gold'
                              : 'text-nc-mut-2'}"
                        >
                          {i18n.t(`cloud.eleven.state.${k.state}`)}
                          {#if k.state === 'cooldown' && k.cooldownSecs}
                            · {Math.ceil(k.cooldownSecs / 60)}m
                          {/if}
                        </span>
                        <span class="w-10 text-right text-[11px] text-nc-mut tabular-nums">
                          {used < 0 ? '—' : `${used}%`}
                        </span>
                      </div>
                      <div
                        class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-nc-panel"
                        role="meter"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        aria-valuenow={used < 0 ? undefined : used}
                        aria-label={`${k.masked} quota`}
                      >
                        {#if used >= 0}
                          <div
                            class="h-full rounded-full transition-[width] duration-300 {used >= 85
                              ? 'bg-nc-red'
                              : used >= 60
                                ? 'bg-nc-gold'
                                : 'bg-nc-brand'}"
                            style="width:{used}%"
                          ></div>
                        {/if}
                      </div>
                      {#if k.quotaLimit}
                        <div class="mt-0.5 text-[10.5px] text-nc-mut-2 tabular-nums">
                          {num(k.quotaUsed)} / {num(k.quotaLimit)}
                          {i18n.t('usage.elevenChars')}
                        </div>
                      {/if}
                    </li>
                  {/each}
                </ul>
                <p class="mt-3 text-[11.5px] leading-relaxed text-nc-mut-2">
                  {i18n.t('usage.elevenNote')}
                </p>
              {/if}
            </div>

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
            {#each serviceList as svc (svc)}
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

          <!-- ─────────────────────────── history ─────────────────────────── -->
        {:else if tab === 'history'}
          <div class="space-y-4">
            {#if historyBusy}
              <p class="text-[12px] text-nc-mut">{i18n.t('usage.loading')}</p>
            {:else}
              <!-- 30-day timeline -->
              <div class="rounded-xl border border-nc-line bg-nc-panel-2/60 p-4">
                <div class="flex items-center gap-2">
                  <span class="text-[13px] font-semibold text-nc-txt">
                    {i18n.t('usage.timeline')}
                  </span>
                  <span class="ml-auto text-[11px] text-nc-mut-2">
                    {i18n.t('usage.last30')}
                  </span>
                </div>
                {#if timeline.length === 0}
                  <p class="mt-3 text-[12px] text-nc-mut-2">
                    {i18n.t('usage.recentEmpty')}
                  </p>
                {:else}
                  {@const maxCalls = Math.max(1, ...timeline.map((d) => d.calls))}
                  <div class="mt-3 flex items-end gap-1" style="height:96px">
                    {#each timeline.slice().reverse() as d (d.day + d.service)}
                      <div
                        class="flex-1 rounded-t bg-nc-brand/70 transition-[height] duration-200"
                        style="height:{Math.max(4, (d.calls / maxCalls) * 96)}px"
                        title={`${d.day} · ${d.service} · ${d.calls} calls`}
                      ></div>
                    {/each}
                  </div>
                  <div class="mt-1 flex justify-between text-[10px] text-nc-mut-2 tabular-nums">
                    <span>{timeline[timeline.length - 1]?.day ?? ''}</span>
                    <span>{timeline[0]?.day ?? ''}</span>
                  </div>
                {/if}
              </div>

              <!-- filter -->
              <div class="flex items-center gap-2">
                <label class="text-[11px] text-nc-mut-2" for="hist-filter">
                  {i18n.t('usage.filter')}
                </label>
                <select
                  id="hist-filter"
                  bind:value={historyService}
                  class="rounded-lg border border-nc-line bg-nc-panel-2 px-2 py-1 text-[12px] text-nc-txt"
                >
                  <option value="">{i18n.t('usage.all')}</option>
                  {#each ['elevenlabs', 'groq', 'gemini'] as s (s)}
                    <option value={s}>{s}</option>
                  {/each}
                </select>
              </div>

              <!-- recent calls table -->
              <div class="rounded-xl border border-nc-line bg-nc-panel-2/60 p-3">
                {#if calls.length === 0}
                  <p class="text-[12px] text-nc-mut-2">{i18n.t('usage.recentEmpty')}</p>
                {:else}
                  <div class="overflow-x-auto">
                    <table class="w-full text-[11px] tabular-nums">
                      <thead>
                        <tr class="text-left text-nc-mut-2">
                          <th class="pb-1 pr-2 font-medium">{i18n.t('usage.when')}</th>
                          <th class="pb-1 pr-2 font-medium">{i18n.t('usage.engine')}</th>
                          <th class="pb-1 pr-2 font-medium">{i18n.t('usage.op')}</th>
                          <th class="pb-1 pr-2 font-medium">{i18n.t('usage.status')}</th>
                          <th class="pb-1 pr-2 font-medium text-right">{i18n.t('usage.latency')}</th>
                          <th class="pb-1 pr-2 font-medium text-right">{i18n.t('usage.tokens')}</th>
                          <th class="pb-1 font-medium text-right">{i18n.t('usage.audio')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each calls as c (c.id)}
                          <tr class="border-t border-nc-line/70">
                            <td class="py-1 pr-2 text-nc-mut-2">{timeAgo(new Date(c.ts * 1000).toISOString())}</td>
                            <td class="py-1 pr-2 capitalize text-nc-txt">{c.service}</td>
                            <td class="py-1 pr-2 text-nc-mut">{c.op || '—'}</td>
                            <td
                              class="py-1 pr-2 {c.status >= 400 || c.err
                                ? 'text-nc-red'
                                : 'text-nc-green'}">{c.status || 'net'}</td
                            >
                            <td class="py-1 pr-2 text-right">{c.latencyMs} ms</td>
                            <td class="py-1 pr-2 text-right">{c.tokensIn}→{c.tokensOut}</td>
                            <td class="py-1 text-right">
                              {c.audioSecs > 0 ? `${c.audioSecs.toFixed(1)}s` : '—'}
                            </td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {/if}
              </div>
            {/if}
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
