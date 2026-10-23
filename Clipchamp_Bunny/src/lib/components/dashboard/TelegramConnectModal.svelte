<script lang="ts">
  /**
   * THE TELEGRAM LOGIN MODAL — QR only, and honest about every state.
   *
   * The Go daemon logs in with a QR scan by design (there is no phone-number
   * flow to offer — see `go/internal/vault/login.go`), so this modal does not
   * pretend otherwise. It drives the real state machine:
   *
   *   idle → starting → waiting (a `tg://login?token=…` link Telegram issued)
   *        → authorised | expired | password_needed | failed
   *
   * It never draws a decorative QR. A QR image needs a real token URL from the
   * daemon; when one exists it is offered as a link that actually opens
   * Telegram (a genuine auth path, not decoration), and the desktop build will
   * additionally render it as a scannable code. Today the daemon has no
   * Telegram credentials configured, so the modal shows that plainly instead
   * of faking a code. The session/secret is never displayed.
   */
  import { i18n } from '../../stores/i18n.svelte';
  import { beginTelegramLogin, pollTelegramLogin, type LoginChallenge } from '../../cloud';

  interface Props {
    open: boolean;
    /** Called when Telegram reports the account is linked. */
    onlinked?: (account: string) => void;
  }

  let { open = $bindable(false), onlinked }: Props = $props();

  type View = 'idle' | 'starting' | 'waiting' | 'done' | 'error';
  let view = $state<View>('idle');
  let challenge = $state<LoginChallenge | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  /** A daemon that is not configured is a distinct, explainable state. */
  const notConfigured = $derived(
    view === 'error' && (challenge?.detail ?? '').toLowerCase().includes('not configured')
  );

  async function start(): Promise<void> {
    if (view === 'starting') return;
    view = 'starting';
    challenge = null;
    const c = await beginTelegramLogin();
    applyChallenge(c);
  }

  function applyChallenge(c: LoginChallenge): void {
    challenge = c;
    switch (c.phase) {
      case 'waiting':
        view = 'waiting';
        beginPolling(c.id);
        break;
      case 'authorised':
        view = 'done';
        stopPolling();
        onlinked?.(c.account ?? '');
        break;
      case 'expired':
      case 'password_needed':
      case 'failed':
        view = 'error';
        stopPolling();
        break;
    }
  }

  function beginPolling(id: string): void {
    stopPolling();
    if (!id) return;
    pollTimer = setInterval(() => {
      void pollTelegramLogin(id).then(applyChallenge);
    }, 3000);
  }

  function stopPolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function close(): void {
    stopPolling();
    open = false;
    // Reset for the next open so a past failure does not greet the user.
    view = 'idle';
    challenge = null;
  }

  // Stop the poll loop if the modal is dismissed by any other means.
  $effect(() => {
    if (!open) stopPolling();
  });
</script>

{#if open}
  <!-- backdrop: click closes it, and Escape has genuine keyboard parity with
       that click (Enter/Space are deliberately NOT handled here — they must go
       to whatever button inside the dialog actually has focus) -->
  <div
    class="t9-fade-in fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
    role="presentation"
    onclick={close}
    onkeydown={(e) => {
      if (e.key === 'Escape') close();
    }}
  >
    <!-- panel: click inside must not close. `tabindex="-1"` makes it a valid
         focus target so focus can land in the dialog when it opens (keyboard /
         screen-reader users are dropped inside, not left behind it); it is -1
         so it does NOT enter the tab order. Escape closes from here too. -->
    <div
      class="t9-panel-in w-full max-w-[420px] rounded-2xl border border-nc-line bg-nc-panel p-5 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="t9-tg-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 id="t9-tg-title" class="text-[16px] font-semibold text-nc-txt">
            {i18n.t('cloud.tg.modalTitle')}
          </h2>
          <p class="mt-1 text-[12px] leading-relaxed text-nc-mut">
            {i18n.t('cloud.tg.modalDesc')}
          </p>
        </div>
        <button
          type="button"
          onclick={close}
          aria-label={i18n.t('cloud.tg.close')}
          class="grid h-7 w-7 shrink-0 place-items-center rounded-md text-nc-mut-2
                 transition-colors hover:bg-nc-panel-2 hover:text-nc-txt"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      <!-- the body of the state machine -->
      <div class="mt-4">
        {#if view === 'idle'}
          <button
            type="button"
            onclick={() => void start()}
            class="inline-flex items-center gap-2 rounded-lg bg-nc-brand px-3.5 py-2 text-[13px]
                   font-medium text-white transition-[filter] duration-150 hover:brightness-110"
          >
            <svg
              width="15"
              height="15"
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
            {i18n.t('cloud.tg.scan')}
          </button>
        {:else if view === 'starting'}
          <div class="flex items-center gap-2 text-[13px] text-nc-mut">
            <span
              class="t9-spin inline-block h-4 w-4 rounded-full border-[1.5px] border-nc-brand/30 border-t-nc-brand"
              aria-hidden="true"
            ></span>
            {i18n.t('cloud.tg.waiting')}
          </div>
        {:else if view === 'waiting'}
          <!-- A real token Telegram issued. Offered as a link that opens
               Telegram; the desktop build draws it as a QR too. -->
          {#if challenge?.url}
            <a
              href={challenge.url}
              class="inline-flex items-center gap-2 rounded-lg bg-nc-brand px-3.5 py-2 text-[13px]
                     font-medium text-white transition-[filter] duration-150 hover:brightness-110"
            >
              {i18n.t('cloud.tg.open')}
            </a>
            <p class="mt-3 flex items-center gap-2 text-[13px] text-nc-mut">
              <span
                class="t9-spin inline-block h-4 w-4 rounded-full border-[1.5px] border-nc-brand/30 border-t-nc-brand"
                aria-hidden="true"
              ></span>
              {i18n.t('cloud.tg.waiting')}
            </p>
          {:else}
            <p class="text-[13px] text-nc-mut">{i18n.t('cloud.tg.waiting')}</p>
          {/if}
        {:else if view === 'done'}
          <p class="flex items-center gap-2 text-[13px] text-nc-green">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            {i18n.t('cloud.tg.done')}{challenge?.account ? ` — ${challenge.account}` : ''}
          </p>
        {:else if view === 'error'}
          {#if notConfigured}
            <p class="text-[13px] leading-relaxed text-nc-mut">{i18n.t('cloud.tg.notReady')}</p>
          {:else if challenge?.detail === 'offline'}
            <p class="text-[13px] text-nc-mut">{i18n.t('cloud.tg.offline')}</p>
          {:else if challenge?.phase === 'expired'}
            <p class="text-[13px] text-nc-mut">{i18n.t('cloud.tg.expired')}</p>
          {:else}
            <p class="text-[13px] text-nc-red">{i18n.t('cloud.tg.failed')}</p>
          {/if}
          <button
            type="button"
            onclick={() => void start()}
            class="mt-3 inline-flex items-center gap-2 rounded-lg border border-nc-line bg-nc-panel-2
                   px-3 py-1.5 text-[12.5px] font-medium text-nc-txt transition-colors hover:border-nc-brand/50"
          >
            {i18n.t('cloud.tg.retry')}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
