<script lang="ts">
  /**
   * THE ELEVENLABS PANEL — the primary transcriber's account pool.
   *
   * ElevenLabs Scribe is the engine transcription prefers, and the user owns
   * a POOL of free accounts rather than one key. This panel is the pool's
   * only surface, and it keeps the same honesty rules as the ApiKeyCard:
   *
   *   · "Add key" runs the daemon's real probe first (`/v1/keys/elevenlabs/add`
   *     is probe-then-add), so a typo is refused with the provider's sentence
   *     and never enters the pool.
   *   · the summary strip and every row show what the SCHEDULER decided —
   *     ready, cooling (with the wait), disabled — plus the account's real
   *     monthly quota from the last probe, never a decorative bar.
   *   · removing uses the stable hash the list returned; the full key never
   *     comes back to the UI and lives only in this component's one input.
   *   · colour never carries state alone: every pill has words in it, and
   *     dynamic results sit in role=status regions so a screen reader hears
   *     the outcome too.
   *
   * The `.env` import lives in its own component (ElevenEnvImport) — same
   * file's three key variables, batch-reported, told back here only as "go
   * re-read the pool".
   *
   * The pill at the top is `/healthz`'s `transcribe_elevenlabs` capability —
   * what the daemon can run, never what the form looks like.
   */
  import { onMount } from 'svelte';
  import { i18n } from '../../stores/i18n.svelte';
  import {
    addElevenKey,
    clearElevenKeys,
    fetchElevenKeys,
    removeElevenKey,
    type ElevenKeyStatus
  } from '../../cloud';
  import ElevenEnvImport from './ElevenEnvImport.svelte';

  interface Props {
    /** `/healthz` → cloud.transcribe_elevenlabs === 'ready'. */
    configured: boolean;
    /** `/healthz` → cloud.ensemble === 'ready' (both engines + reconciler). */
    ensemble: boolean;
    /** Stagger index for the entrance animation. */
    index?: number;
  }

  let { configured, ensemble, index = 0 }: Props = $props();

  let keys = $state<ElevenKeyStatus[]>([]);
  let loading = $state(true);
  /** A remove/clear failure, shown in red under the list. */
  let listError = $state('');

  /* ---- add form ---- */
  let newKey = $state('');
  let reveal = $state(false);
  let adding = $state(false);
  let addResult = $state<{ ok: boolean; detail: string } | null>(null);

  async function refresh(): Promise<void> {
    const res = await fetchElevenKeys();
    if (res) keys = res.keys;
    loading = false;
  }

  onMount(() => void refresh());

  /** The header line: "6 accounts · 5 ready · 1 cooling" — one glance. */
  const summary = $derived(
    keys.length === 0
      ? ''
      : i18n.t('cloud.eleven.summary', {
          total: keys.length,
          ready: keys.filter((k) => k.state === 'ready').length,
          cooling: keys.filter((k) => k.state === 'cooldown').length
        })
  );

  async function add(): Promise<void> {
    if (adding) return;
    const typed = newKey.trim();
    if (!typed) {
      addResult = { ok: false, detail: i18n.t('cloud.eleven.needKey') };
      return;
    }
    adding = true;
    addResult = null;
    try {
      const res = await addElevenKey(typed);
      addResult = res.ok
        ? { ok: true, detail: res.note || i18n.t('cloud.eleven.added') }
        : { ok: false, detail: detailText(res.detail) };
      if (res.ok) newKey = '';
      await refresh();
    } finally {
      adding = false;
    }
  }

  async function remove(id: string): Promise<void> {
    listError = '';
    const res = await removeElevenKey(id);
    if (!res.ok) listError = detailText(res.detail);
    await refresh();
  }

  async function clearAll(): Promise<void> {
    listError = '';
    const res = await clearElevenKeys();
    if (!res.ok) listError = detailText(res.detail);
    await refresh();
  }

  /** Quota bar position, or null when no probe has reported a limit yet. */
  function pct(k: ElevenKeyStatus): number | null {
    if (!k.quotaLimit) return null;
    return Math.min(100, Math.round(((k.quotaUsed ?? 0) / k.quotaLimit) * 100));
  }

  /**
   * The daemon's failure vocabulary → a sentence the user can act on.
   *
   * `unavailable` and `network` are the service layer's stable tokens; showing
   * them raw would be the UI leaking its own plumbing at someone who only
   * wanted to add a key. Anything else (the provider's probe sentence) passes
   * through untouched — that one is already human.
   */
  function detailText(detail: string): string {
    if (detail === 'unavailable') return i18n.t('cloud.daemonDown');
    if (detail === 'network') return i18n.t('cloud.eleven.network');
    return detail;
  }

  function cooldownText(secs?: number): string {
    if (!secs || secs <= 0) return '';
    if (secs >= 3600) return `${Math.ceil(secs / 3600)}h`;
    if (secs >= 60) return `${Math.ceil(secs / 60)}m`;
    return `${secs}s`;
  }
</script>

<div
  class="t9-card-in flex flex-col rounded-xl border border-nc-line bg-nc-panel/70 p-4 backdrop-blur-md
         transition-[border-color,transform] duration-150 ease-out hover:-translate-y-0.5 hover:border-nc-line-2"
  style="--i:{index}"
>
  <!-- header: icon · name · status pill -->
  <div class="flex items-center gap-2.5">
    <span
      class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-nc-line bg-nc-panel-2"
      aria-hidden="true"
    >
      <!-- a waveform: the primary transcriber, drawn not imported -->
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        class="text-nc-brand"
      >
        <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
      </svg>
    </span>

    <h3 class="min-w-0 flex-1 truncate text-[14px] font-semibold text-nc-txt">
      {i18n.t('cloud.eleven.name')}
    </h3>

    <span
      class="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium
             {configured ? 'bg-nc-green/15 text-nc-green' : 'bg-nc-mut/10 text-nc-mut'}"
    >
      {i18n.t(configured ? 'cloud.connected' : 'cloud.notConnected')}
    </span>
  </div>

  <p class="mt-2 text-[12px] leading-relaxed text-nc-mut">{i18n.t('cloud.eleven.desc')}</p>

  {#if ensemble}
    <p class="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-nc-mut-2">
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        class="mt-px shrink-0 text-nc-brand"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
      {i18n.t('cloud.eleven.ensemble')}
    </p>
  {/if}

  <!-- ── the pool ─────────────────────────────────────────────────────── -->
  <div class="mt-3" role="list" aria-label={i18n.t('cloud.eleven.listLabel')}>
    {#if loading}
      <p role="status" class="text-[12px] text-nc-mut-2">{i18n.t('cloud.eleven.loading')}</p>
    {:else if keys.length === 0}
      <p class="text-[12px] leading-relaxed text-nc-mut-2">{i18n.t('cloud.eleven.empty')}</p>
    {:else}
      <p class="mb-2 text-[11px] font-medium tracking-wide text-nc-mut-2 uppercase">
        {summary}
      </p>

      {#each keys as k (k.id)}
        <div
          role="listitem"
          class="mb-1.5 rounded-lg border border-nc-line/70 bg-nc-bg/40 px-2.5 py-2"
        >
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-nc-txt">
              {k.masked}
            </span>

            <!-- state pill: colour AND word, never colour alone -->
            <span
              class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium
                     {k.state === 'ready'
                ? 'bg-nc-green/15 text-nc-green'
                : k.state === 'cooldown'
                  ? 'bg-nc-amber/15 text-nc-amber'
                  : 'bg-nc-red/15 text-nc-red'}"
            >
              {#if k.state === 'cooldown' && cooldownText(k.cooldownSecs)}
                {i18n.t('cloud.eleven.cooldown', { wait: cooldownText(k.cooldownSecs) })}
              {:else}
                {i18n.t(`cloud.eleven.state.${k.state}`)}
              {/if}
            </span>

            {#if k.quotaLimit}
              <span class="shrink-0 text-[10.5px] text-nc-mut-2 tabular-nums">
                {pct(k)}% {i18n.t('cloud.eleven.quotaUsed')}
              </span>
            {/if}

            <button
              type="button"
              onclick={() => void remove(k.id)}
              aria-label={i18n.t('cloud.eleven.removeOne', { key: k.masked })}
              class="grid h-6 w-6 shrink-0 place-items-center rounded text-nc-mut-2
                     transition-colors hover:bg-nc-red/10 hover:text-nc-red
                     focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-nc-brand"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                aria-hidden="true"
              >
                <path d="M5 5l14 14M19 5 5 19" />
              </svg>
            </button>
          </div>

          {#if k.quotaLimit}
            <!-- the real monthly quota from the last probe, nothing decorative -->
            <div
              class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-nc-panel-2"
              role="progressbar"
              aria-label={k.tier
                ? `${k.tier} ${i18n.t('cloud.eleven.quotaUsed')}`
                : i18n.t('cloud.eleven.quotaUsed')}
              aria-valuenow={pct(k) ?? 0}
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div class="h-full rounded-full bg-nc-brand/70" style="width:{pct(k)}%"></div>
            </div>
          {/if}

          {#if k.lastError}
            <p class="mt-1 truncate text-[10.5px] text-nc-mut-2" title={k.lastError}>
              {k.lastError}
            </p>
          {/if}
        </div>
      {/each}

      <button
        type="button"
        onclick={() => void clearAll()}
        class="mt-1 text-[11px] text-nc-mut-2 underline-offset-2 transition-colors
               hover:text-nc-red hover:underline focus-visible:outline-2
               focus-visible:outline-offset-2 focus-visible:outline-nc-brand"
      >
        {i18n.t('cloud.eleven.clearAll')}
      </button>
    {/if}
  </div>

  {#if listError}
    <p role="alert" class="mt-1.5 text-[11.5px] text-nc-red">{listError}</p>
  {/if}

  <!-- ── add one account ──────────────────────────────────────────────── -->
  <div class="mt-3">
    <label for="t9-eleven-key" class="mb-1.5 block text-[11px] font-medium text-nc-mut-2">
      {i18n.t('cloud.eleven.keyLabel')}
    </label>
    <div class="relative">
      <input
        id="t9-eleven-key"
        type={reveal ? 'text' : 'password'}
        bind:value={newKey}
        placeholder={i18n.t('cloud.eleven.keyPlaceholder')}
        autocomplete="off"
        spellcheck="false"
        class="w-full rounded-lg border border-nc-line bg-nc-bg/70 py-2 pr-9 pl-3 text-[13px]
               text-nc-txt placeholder:text-nc-mut-2 focus:border-nc-brand/60 focus:outline-none"
      />
      <button
        type="button"
        onclick={() => (reveal = !reveal)}
        aria-label={i18n.t(reveal ? 'cloud.hideKey' : 'cloud.showKey')}
        aria-pressed={reveal}
        class="absolute inset-y-0 right-0 grid w-9 place-items-center text-nc-mut-2
               transition-colors hover:text-nc-txt"
      >
        {#if reveal}
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
          >
            <path
              d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.4 5.2A9.7 9.7 0 0 1 12 5c5 0 9 4.5 9 7 0 .8-.6 2-1.7 3.2M6.2 6.7C3.9 8.3 3 10.4 3 12c0 2.5 4 7 9 7 1.3 0 2.5-.3 3.6-.8"
            />
          </svg>
        {:else}
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
          >
            <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z" /><circle
              cx="12"
              cy="12"
              r="2.4"
            />
          </svg>
        {/if}
      </button>
    </div>

    <button
      type="button"
      onclick={() => void add()}
      disabled={adding}
      class="mt-2 inline-flex items-center justify-center gap-2 self-start rounded-lg border border-nc-brand/50
             bg-nc-brand/10 px-3 py-1.5 text-[12.5px] font-medium text-nc-brand
             transition-[filter,background-color] duration-150 ease-out
             hover:bg-nc-brand/20 disabled:opacity-60
             focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nc-brand"
    >
      {#if adding}
        <span
          class="t9-spin inline-block h-3.5 w-3.5 rounded-full border-[1.5px]
                 border-nc-brand/30 border-t-nc-brand"
          aria-hidden="true"
        ></span>
        {i18n.t('cloud.testing')}
      {:else}
        {i18n.t('cloud.eleven.add')}
      {/if}
    </button>

    {#if addResult}
      <p
        role="status"
        class="mt-2 flex items-start gap-1.5 text-[12px] leading-snug
               {addResult.ok ? 'text-nc-green' : 'text-nc-red'}"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="mt-px shrink-0"
          aria-hidden="true"
        >
          {#if addResult.ok}
            <path d="M20 6 9 17l-5-5" />
          {:else}
            <path d="M12 8v5m0 3h.01M12 3l9 16H3l9-16Z" />
          {/if}
        </svg>
        <span>{addResult.detail}</span>
      </p>
    {/if}
  </div>

  <!-- ── import a whole .env ──────────────────────────────────────────── -->
  <div class="mt-3.5">
    <ElevenEnvImport onImported={() => void refresh()} />
  </div>
</div>
