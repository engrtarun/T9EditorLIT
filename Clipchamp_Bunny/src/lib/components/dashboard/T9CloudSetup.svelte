<script lang="ts">
  /**
   * THE T9 CLOUD PAGE — "Connect your workspace".
   *
   * A central setup surface for the four services the rest of the app leans
   * on: T9 Cloud (the local daemon), Gemini, Groq and Telegram. It sits over
   * the same background video as Home, with one restrained dark gradient
   * behind the content column so the forms stay readable — the footage is
   * never blurred, tinted or filtered, and stays visible toward the right.
   *
   * Rules this page keeps, straight from the spec and AGENTS.md:
   *   · **Nothing here is fake.** The status pills and the "n of 4" progress
   *     come from the daemon's real `/healthz` capabilities and the vault's
   *     real `/v1/vault/status`. A service reads "connected" only when the
   *     daemon says it can actually run it — never because a box is non-empty.
   *   · The two API-key tiles run a real key probe through the daemon
   *     (`ApiKeyCard`), so a dead key is reported as dead.
   *   · Telegram login is QR-only, matching the Go backend's design, and the
   *     modal never draws a decorative code.
   *
   * (The slowly-rotating phrase lives on the dashboard's "T9 Cloud" nav label
   * in `DashboardTopBar.svelte`, not here — so this page's own layout never
   * shifts and the animation has exactly one home.)
   *
   * Backend wiring is deferred (the user's directive: the desktop UI is being
   * finalised first; real backend + logic get attached later). `cloud.ts` is
   * the single seam where that happens, and it already speaks the daemon's
   * real shapes.
   */
  import { onMount } from 'svelte';
  import { i18n } from '../../stores/i18n.svelte';
  import { fetchHealth, fetchVaultStatus, type CloudHealth, type VaultStatus } from '../../cloud';
  import ApiKeyCard from './ApiKeyCard.svelte';
  import TelegramConnectModal from './TelegramConnectModal.svelte';

  /* -------------------------------------------------------- live daemon state */

  let health = $state<CloudHealth | null>(null);
  let vault = $state<VaultStatus | null>(null);
  let loading = $state(true);

  onMount(() => {
    void refresh();
  });

  async function refresh(): Promise<void> {
    loading = true;
    // Both calls are honest: `null` means the daemon is not running, and the
    // cards fall back to "not connected" rather than inventing a state.
    const [h, v] = await Promise.all([fetchHealth(), fetchVaultStatus()]);
    health = h;
    vault = v;
    loading = false;
  }

  /** Which of the four services the daemon reports as genuinely usable. */
  const ready = $derived({
    // A pipeline is usable when its capability string is exactly "ready".
    gemini: health?.cloud?.analyze === 'ready',
    groq: health?.cloud?.transcribe === 'ready',
    // Telegram is only "connected" when the stored session is authorised.
    telegram: vault?.authorised === true,
    // T9 Cloud itself is up when the daemon answered at all.
    t9: health?.ok === true
  });

  const configuredCount = $derived(
    Number(ready.gemini) + Number(ready.groq) + Number(ready.telegram) + Number(ready.t9)
  );

  const daemonDown = $derived(health === null && !loading);

  /* --------------------------------------------------------- telegram modal */

  let tgOpen = $state(false);

  function onLinked(): void {
    tgOpen = false;
    // Re-read the vault so the pill flips to "connected" for real.
    void fetchVaultStatus().then((v) => (vault = v));
  }

  /* ------------------------------------------------------------- completion */

  function completeSetup(): void {
    // Honest: the button is enabled only when all four are ready, so this is
    // a confirmation, not a claim that fixes anything.
    if (configuredCount === 4) {
      // Placeholder for the real "proceed" once the backend defines it.
    }
  }
</script>

<div class="t9-fade-in relative min-h-full">
  <!--
    A single, restrained gradient behind the content column only: dark on the
    left where the text and forms live, fading out by the middle so the video
    subject stays visible on the right. No blur, no tint on the footage itself.
  -->
  <div
    class="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-r from-black/70 via-black/40 to-transparent"
    aria-hidden="true"
  ></div>

  <div class="mx-auto max-w-[1180px] px-7 py-8">
    <!-- heading (the rotating phrase lives on the nav label in DashboardTopBar) -->
    <div>
      <h1 class="max-w-[720px] text-[30px] leading-tight font-bold tracking-tight text-nc-txt">
        <span class="text-nc-brand">{i18n.t('cloud.titleAccent')}</span>
        {i18n.t('cloud.titleRest')}
      </h1>

      <p class="mt-2 max-w-[560px] text-[13.5px] leading-relaxed text-nc-mut">
        {i18n.t('cloud.sub')}
      </p>
    </div>

    <!-- progress: counts only services the daemon says are genuinely ready -->
    <div class="mt-5 flex items-center gap-4">
      <div class="flex items-center gap-2.5">
        <div class="h-1.5 w-32 overflow-hidden rounded-full bg-nc-panel-2">
          <div
            class="h-full rounded-full bg-nc-brand transition-[width] duration-300 ease-out"
            style="width:{(configuredCount / 4) * 100}%"
          ></div>
        </div>
        <span class="text-[12.5px] whitespace-nowrap text-nc-mut">
          {i18n.t('cloud.progress', { done: configuredCount, total: 4 })}
          · {i18n.t('cloud.progressLabel')}
        </span>
      </div>

      <button
        type="button"
        onclick={completeSetup}
        disabled={configuredCount !== 4}
        class="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-nc-brand/50 bg-nc-brand/10
               px-3 py-1.5 text-[12.5px] font-medium text-nc-brand transition-[filter,background-color]
               duration-150 hover:bg-nc-brand/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {i18n.t('cloud.completeSetup')}
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
    </div>

    {#if daemonDown}
      <!-- The daemon is not running: say so once, up top, instead of four
           confusing "not connected" cards with no explanation. -->
      <div
        class="mt-5 flex items-center gap-2.5 rounded-lg border border-nc-line bg-nc-panel/70 px-3.5 py-2.5
               text-[12.5px] text-nc-mut backdrop-blur-md"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          class="shrink-0 text-nc-mut-2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" /><path d="M12 8v5m0 3h.01" />
        </svg>
        <span>{i18n.t('cloud.daemonDown')}</span>
      </div>
    {/if}

    <!-- the four service cards: two columns wide, one when narrow -->
    <div class="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <ApiKeyCard service="gemini" configured={ready.gemini} index={0} />
      <ApiKeyCard service="groq" configured={ready.groq} index={1} />

      <!-- Telegram MTProto -->
      <div
        class="t9-card-in flex flex-col rounded-xl border border-nc-line bg-nc-panel/70 p-4 backdrop-blur-md
               transition-[border-color,transform] duration-150 ease-out hover:-translate-y-0.5 hover:border-nc-line-2"
        style="--i:2"
      >
        <div class="flex items-center gap-2.5">
          <span
            class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-nc-line bg-nc-panel-2"
            aria-hidden="true"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              class="text-nc-brand"
            >
              <path
                d="M21.5 4.3 2.9 11.4c-.9.3-.9 1.2 0 1.5l4.6 1.4 1.7 5.3c.2.7 1.1.9 1.6.3l2.5-2.6 4.6 3.4c.6.4 1.4.1 1.6-.6l3-14.6c.2-.9-.5-1.6-1.3-1.2Z"
              />
            </svg>
          </span>
          <h3 class="min-w-0 flex-1 truncate text-[14px] font-semibold text-nc-txt">
            {i18n.t('cloud.telegram.name')}
          </h3>
          <span
            class="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium
                   {ready.telegram ? 'bg-nc-green/15 text-nc-green' : 'bg-nc-mut/10 text-nc-mut'}"
          >
            {i18n.t(ready.telegram ? 'cloud.connected' : 'cloud.notConnected')}
          </span>
        </div>

        <p class="mt-2 text-[12px] leading-relaxed text-nc-mut">{i18n.t('cloud.telegram.desc')}</p>

        {#if vault?.account}
          <p class="mt-2 text-[12px] text-nc-mut-2">
            {i18n.t('cloud.telegram.connectedAs', { account: vault.account })}
          </p>
        {/if}

        <button
          type="button"
          onclick={() => (tgOpen = true)}
          class="mt-3.5 inline-flex items-center justify-center gap-2 self-start rounded-lg border border-nc-brand/50
                 bg-nc-brand/10 px-3 py-1.5 text-[12.5px] font-medium text-nc-brand
                 transition-[filter,background-color] duration-150 hover:bg-nc-brand/20"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
          >
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect
              x="14"
              y="3"
              width="7"
              height="7"
              rx="1"
            /><rect x="3" y="14" width="7" height="7" rx="1" /><path
              d="M14 14h3v3h-3zM18 18h3v3h-3z"
            />
          </svg>
          {i18n.t(ready.telegram ? 'cloud.telegram.manage' : 'cloud.scanQR')}
        </button>
      </div>

      <!-- T9 Cloud (the local daemon) -->
      <div
        class="t9-card-in flex flex-col rounded-xl border border-nc-line bg-nc-panel/70 p-4 backdrop-blur-md
               transition-[border-color,transform] duration-150 ease-out hover:-translate-y-0.5 hover:border-nc-line-2"
        style="--i:3"
      >
        <div class="flex items-center gap-2.5">
          <span
            class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-nc-line bg-nc-panel-2"
            aria-hidden="true"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              class="text-nc-brand"
            >
              <path d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 8.5H7Z" />
            </svg>
          </span>
          <h3 class="min-w-0 flex-1 truncate text-[14px] font-semibold text-nc-txt">
            {i18n.t('cloud.t9.name')}
          </h3>
          <span
            class="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium
                   {ready.t9 ? 'bg-nc-green/15 text-nc-green' : 'bg-nc-mut/10 text-nc-mut'}"
          >
            {i18n.t(ready.t9 ? 'cloud.connected' : 'cloud.incomplete')}
          </span>
        </div>

        <p class="mt-2 text-[12px] leading-relaxed text-nc-mut">{i18n.t('cloud.t9.desc')}</p>

        {#if health}
          <p class="mt-2 text-[12px] text-nc-mut-2">
            {i18n.t('cloud.t9.version', { version: health.version })}
          </p>
        {/if}

        <button
          type="button"
          onclick={refresh}
          class="mt-3.5 inline-flex items-center justify-center gap-2 self-start rounded-lg border border-nc-line
                 bg-nc-panel-2 px-3 py-1.5 text-[12.5px] font-medium text-nc-txt
                 transition-[border-color] duration-150 hover:border-nc-brand/50"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
          >
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
          </svg>
          {i18n.t('cloud.t9.check')}
        </button>
      </div>
    </div>

    <!-- honest footnote about credentials -->
    <p class="mt-6 flex items-center gap-1.5 text-[12px] text-nc-mut-2">
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        class="shrink-0"
        aria-hidden="true"
      >
        <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
      </svg>
      {i18n.t('cloud.footer')}
    </p>
  </div>

  <TelegramConnectModal bind:open={tgOpen} onlinked={onLinked} />
</div>
