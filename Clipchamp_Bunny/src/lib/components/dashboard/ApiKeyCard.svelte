<script lang="ts">
  /**
   * ONE API-KEY CARD — reused by the Gemini and Groq tiles on the T9 Cloud
   * page. It is the only place a credential is ever typed, so the rules about
   * keys live here exactly once:
   *
   *   · "Save & test" always runs the daemon's REAL probe (`POST /v1/keys/probe`
   *     lists the account's models), so a dead key is reported honestly. A
   *     non-empty field alone never reads as "connected".
   *   · the typed key is never echoed back, never stored in this component's
   *     state beyond the input, and never sent anywhere but the loopback
   *     daemon.
   *   · the pill at the top reflects what the daemon says it has configured
   *     (from `/healthz`), not what is in the box.
   *
   * Saving the key for good is the desktop backend's job (`BACKEND.md`
   * Task 2); until that lands the card says so plainly instead of pretending
   * the key is kept.
   */
  import { i18n } from '../../stores/i18n.svelte';
  import { probeGemini, probeGroq } from '../../cloud';

  interface Props {
    service: 'gemini' | 'groq';
    /** The daemon already has a working key for this service (from /healthz). */
    configured: boolean;
    /** Stagger index for the entrance, clamped by the caller. */
    index?: number;
  }

  let { service, configured, index = 0 }: Props = $props();

  let key = $state('');
  let reveal = $state(false);
  let testing = $state(false);
  /** The last real probe outcome, or null if none has run yet. */
  let result = $state<{ ok: boolean; detail: string } | null>(null);
  /** Set when a test passed but the key is not persisted (backend pending). */
  let savePending = $state(false);

  // `$derived` (not plain `const`) so these track the `service` prop instead of
  // capturing only its first value — the compiler warns on the latter.
  const nameKey = $derived(service === 'gemini' ? 'cloud.gemini.name' : 'cloud.groq.name');
  const descKey = $derived(service === 'gemini' ? 'cloud.gemini.desc' : 'cloud.groq.desc');

  async function saveAndTest(): Promise<void> {
    if (testing) return;
    const typed = key.trim();
    if (!typed) {
      // An empty box with nothing configured is not a test — say what to do.
      result = { ok: false, detail: i18n.t('cloud.keyPlaceholder') };
      return;
    }
    testing = true;
    result = null;
    savePending = false;
    try {
      const probe = service === 'gemini' ? await probeGemini(typed) : await probeGroq(typed);
      result = probe;
      // The probe is real and green, but nothing persisted the key yet — so
      // say that rather than letting the green pill imply it is saved.
      savePending = probe.ok;
    } finally {
      testing = false;
    }
  }
</script>

<div
  class="t9-card-in flex flex-col rounded-xl border border-nc-line bg-nc-panel/70 p-4
         backdrop-blur-md transition-[border-color,transform] duration-150 ease-out
         hover:-translate-y-0.5 hover:border-nc-line-2"
  style="--i:{index}"
>
  <!-- header: icon · name · status pill -->
  <div class="flex items-center gap-2.5">
    <span
      class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-nc-line bg-nc-panel-2"
      aria-hidden="true"
    >
      {#if service === 'gemini'}
        <!-- a four-point spark: Gemini's mark, drawn not imported -->
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="text-nc-brand">
          <path
            d="M12 2c.4 4.6 3.4 7.6 8 8-4.6.4-7.6 3.4-8 8-.4-4.6-3.4-7.6-8-8 4.6-.4 7.6-3.4 8-8Z"
            fill="currentColor"
          />
        </svg>
      {:else}
        <!-- Groq: a bolt, for speed -->
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="text-nc-brand">
          <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" fill="currentColor" />
        </svg>
      {/if}
    </span>

    <h3 class="min-w-0 flex-1 truncate text-[14px] font-semibold text-nc-txt">
      {i18n.t(nameKey)}
    </h3>

    <span
      class="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium
             {configured ? 'bg-nc-green/15 text-nc-green' : 'bg-nc-mut/10 text-nc-mut'}"
    >
      {i18n.t(configured ? 'cloud.connected' : 'cloud.notConnected')}
    </span>
  </div>

  <p class="mt-2 text-[12px] leading-relaxed text-nc-mut">{i18n.t(descKey)}</p>

  <!-- the key field -->
  <div class="mt-3.5">
    <label for="t9-key-{service}" class="mb-1.5 block text-[11px] font-medium text-nc-mut-2">
      {i18n.t('cloud.keyLabel')}
    </label>

    <div class="relative">
      <input
        id="t9-key-{service}"
        type={reveal ? 'text' : 'password'}
        bind:value={key}
        placeholder={i18n.t('cloud.keyPlaceholder')}
        autocomplete="off"
        spellcheck="false"
        class="w-full rounded-lg border border-nc-line bg-nc-bg/70 py-2 pr-9 pl-3 text-[13px]
               text-nc-txt placeholder:text-nc-mut-2 focus:border-nc-brand/60 focus:outline-none"
      />
      <button
        type="button"
        onclick={() => (reveal = !reveal)}
        aria-label={i18n.t(reveal ? 'cloud.hideKey' : 'cloud.showKey')}
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
  </div>

  <!-- test action -->
  <button
    type="button"
    onclick={() => void saveAndTest()}
    disabled={testing}
    class="mt-3 inline-flex items-center justify-center gap-2 self-start rounded-lg border border-nc-brand/50
           bg-nc-brand/10 px-3 py-1.5 text-[12.5px] font-medium text-nc-brand
           transition-[filter,background-color] duration-150 ease-out
           hover:bg-nc-brand/20 disabled:opacity-60"
  >
    {#if testing}
      <span
        class="t9-spin inline-block h-3.5 w-3.5 rounded-full border-[1.5px]
                   border-nc-brand/30 border-t-nc-brand"
        aria-hidden="true"
      ></span>
      {i18n.t('cloud.testing')}
    {:else}
      {i18n.t('cloud.saveTest')}
    {/if}
  </button>

  <!-- the honest result of the last real probe -->
  {#if result}
    <p
      class="mt-2.5 flex items-start gap-1.5 text-[12px] leading-snug
              {result.ok ? 'text-nc-green' : 'text-nc-red'}"
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
        {#if result.ok}
          <path d="M20 6 9 17l-5-5" />
        {:else}
          <path d="M12 8v5m0 3h.01M12 3l9 16H3l9-16Z" />
        {/if}
      </svg>
      <span>{result.detail}</span>
    </p>
    {#if savePending}
      <p class="mt-1 text-[11px] text-nc-mut-2">{i18n.t('cloud.savePending')}</p>
    {/if}
  {/if}
</div>
