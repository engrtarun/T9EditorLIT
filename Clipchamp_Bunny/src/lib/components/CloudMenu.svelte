<script lang="ts">
  import { cloud } from '../stores/cloud.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import type { ProviderId } from '../types';

  /**
   * Cloud / backup dropdown — Clipchamp's `odsp-backup-button` popover.
   *
   * In Clipchamp this only offers Microsoft (OneDrive). Ours offers:
   *   · Telegram Cloud  — QR scanner + MTProto  → Go t9cloud /v1/vault/authorise
   *   · Gemini API      — fumble detection       → Go t9cloud /v1/analyze
   *   · Groq API        — Whisper transcription  → Go t9cloud /v1/transcribe
   *   · Local disk      — FFmpeg + SQLite
   *
   * ⚠ BACKEND SEAM: `cloud.connect(id)` is where the backend agent plugs in.
   */
  let open = $state(false);
  let qrOpen = $state(false);
  let pos = $state({ x: 0, y: 0 });

  // "Import from Telegram vault" in the media panel asks for the QR flow.
  $effect(() => {
    const openQr = () => {
      open = false;
      qrOpen = true;
    };
    window.addEventListener('t9:connect-telegram', openQr);
    return () => window.removeEventListener('t9:connect-telegram', openQr);
  });

  /** The panel's size, so it can be kept inside the window. */
  const MENU_W = 288;
  const MENU_H = 330;
  /** A hand's width between the panel and the window edge. */
  const EDGE = 8;

  function toggle(e: MouseEvent) {
    if (open) {
      open = false;
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();

    // The panel is anchored to the button, but it must never hang out of the
    // window: on the dashboard this button sits at the far right, and a
    // 288 px panel hanging off the edge looks broken.
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = Math.round(r.left);
    if (x + MENU_W > vw - EDGE) x = vw - EDGE - MENU_W;
    if (x < EDGE) x = EDGE;

    // Not enough room below the button → open upwards instead.
    let y = Math.round(r.bottom + 6);
    if (y + MENU_H > vh - EDGE) y = Math.max(EDGE, Math.round(r.top - MENU_H - 6));

    pos = { x, y };
    open = true;
  }

  function pick(id: ProviderId) {
    const p = cloud.get(id);
    if (!p) return;
    if (p.status === 'connected') cloud.disconnect(id);
    else if (id === 'telegram') qrOpen = true;
    else cloud.connect(id);
  }

  const statusDot: Record<string, string> = {
    connected: 'bg-nc-green',
    pending: 'bg-nc-brand animate-pulse',
    disconnected: 'bg-nc-mut-2'
  };

  const iconOf: Record<ProviderId, 'telegram' | 'spark' | 'bolt' | 'disk'> = {
    telegram: 'telegram',
    gemini: 'spark',
    groq: 'bolt',
    local: 'disk'
  };
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      open = false;
      qrOpen = false;
    }
  }}
/>

<button
  onclick={toggle}
  class="grid h-8 w-8 place-items-center rounded-md border border-nc-line text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
  title="Cloud backup & AI providers"
  aria-haspopup="menu"
  aria-expanded={open}
>
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
  >
    <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.1 9.6 4 4 0 0 0 7 17.9" />
    <path d="M12 12v9M9 15l3-3 3 3" />
  </svg>
</button>

{#if open}
  <!-- click-away catcher -->
  <button
    class="fixed inset-0 z-[190] cursor-default"
    aria-label="Close menu"
    onclick={() => (open = false)}
  ></button>

  <div
    class="fixed z-[200] max-h-[min(330px,70vh)] w-[288px] overflow-y-auto rounded-md border border-nc-line-2 bg-[#1E1E29] p-1 shadow-2xl"
    style="left:{pos.x}px;top:{pos.y}px"
    role="menu"
  >
    <p class="px-2 pt-1 pb-1.5 text-[9px] font-bold tracking-widest text-nc-mut-2">
      BACKUP & AI PROVIDERS
    </p>

    {#each cloud.providers as p (p.id)}
      <button
        role="menuitem"
        onclick={() => pick(p.id)}
        class="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-nc-panel-2"
      >
        <span class="mt-0.5 shrink-0 text-nc-mut"><MenuIcon name={iconOf[p.id]} /></span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5">
            <span class="text-[13px] font-medium">{p.label}</span>
            <i class="h-1.5 w-1.5 shrink-0 rounded-full {statusDot[p.status]}"></i>
            {#if p.badge}
              <span class="ml-auto truncate font-mono text-[9px] text-nc-mut-2">{p.badge}</span>
            {/if}
          </span>
          <span class="block text-[10px] leading-4 text-nc-mut-2">{p.detail}</span>
        </span>
      </button>
      {#if p.id === 'local'}
        <div class="my-1 h-px bg-nc-line-2"></div>
      {/if}
    {/each}

    <div class="mt-0.5 border-t border-nc-line-2 px-2 pt-1.5 pb-1">
      <p class="text-[9px] leading-3.5 text-nc-mut-2">
        Local project: <span class="font-mono text-nc-mut">C:\Users\pocot\Music\T9EditorLIT</span>
      </p>
    </div>
  </div>
{/if}

<!-- Telegram QR authorisation placeholder -->
{#if qrOpen}
  <div
    class="fixed inset-0 z-[400] grid place-items-center bg-black/70"
    role="dialog"
    aria-modal="true"
  >
    <div
      class="w-[300px] rounded-xl border border-nc-line-2 bg-nc-panel p-5 text-center shadow-2xl"
    >
      <div class="mx-auto mb-3 grid h-32 w-32 place-items-center rounded-lg bg-white/95">
        <!-- QR placeholder — real code comes from the Go daemon -->
        <svg
          width="104"
          height="104"
          viewBox="0 0 21 21"
          shape-rendering="crispEdges"
          class="text-nc-bg"
        >
          <path
            fill="currentColor"
            d="M0 0h7v7H0zM14 0h7v7h-7zM0 14h7v7H0zM3 3h1v1H3zM5 3h1v1H5zM3 5h1v1H3zM14 3h1v1h-1zM17 3h1v1h-1zM19 3h1v1h-1zM17 5h1v1h-1zM8 8h1v1H8zM10 8h1v1h-1zM12 8h1v1h-1zM14 8h1v1h-1zM16 8h1v1h-1zM18 8h1v1h-1zM20 8h1v1h-1zM8 10h1v1H8zM10 10h1v1h-1zM12 10h1v1h-1zM14 10h1v1h-1zM16 10h1v1h-1zM18 10h1v1h-1zM20 10h1v1h-1zM9 11h2v1H9zM13 11h2v1h-2zM17 11h2v1h-2zM8 12h1v1H8zM11 12h1v1h-1zM14 12h1v1h-1zM17 12h1v1h-1zM20 12h1v1h-1zM8 14h1v1H8zM10 14h1v1h-1zM12 14h1v1h-1zM14 14h1v1h-1zM16 14h1v1h-1zM18 14h1v1h-1zM20 14h1v1h-1zM8 16h2v1H8zM11 16h1v1h-1zM13 16h2v1h-2zM16 16h1v1h-1zM19 16h1v1h-1zM9 17h2v1H9zM12 17h1v1h-1zM14 17h1v1h-1zM17 17h1v1h-1zM20 17h1v1h-1zM8 18h1v1H8zM10 18h1v1h-1zM12 18h2v1h-2zM15 18h1v1h-1zM18 18h1v1h-1zM9 19h2v1H9zM12 19h1v1h-1zM14 19h1v1h-1zM17 19h1v1h-1zM19 19h1v1h-1zM10 20h1v1h-1zM12 20h1v1h-1zM15 20h1v1h-1zM18 20h1v1h-1z"
          />
        </svg>
      </div>
      <p class="text-sm font-bold text-nc-brand">Telegram · QR scan</p>
      <p class="mt-1.5 text-[11px] leading-relaxed text-nc-mut">
        Telegram app → Settings → Devices → Link Desktop. QR code t9cloud se aayega.
      </p>
      <div class="mt-4 flex gap-2">
        <button
          onclick={() => (qrOpen = false)}
          class="flex-1 rounded-lg border border-nc-line py-1.5 text-xs text-nc-mut hover:bg-nc-panel-2"
        >
          Cancel
        </button>
        <button
          onclick={() => {
            qrOpen = false;
            cloud.connect('telegram');
          }}
          class="flex-1 rounded-lg bg-nc-brand py-1.5 text-xs font-bold text-nc-bg hover:brightness-110"
        >
          Connect
        </button>
      </div>
    </div>
  </div>
{/if}
