<script lang="ts">
  /**
   * The settings dialog.
   *
   * Today it holds one group — trash retention — because that is the only
   * user-settable behaviour the app has. It is a real dialog, not a dropdown,
   * so a future group can be added without re-thinking the layout.
   *
   * The retention is **days**, and `0` means "never auto-delete". The video
   * files are never touched: only the app's trash record expires.
   */
  import { defaultDbPath, purgeExpiredTrash, isTauri } from '../ipc';
  import { layout } from '../stores/layout.svelte';
  import { settings, TRASH_DAYS_DEFAULT } from '../stores/settings.svelte';
  import { toast } from '../stores/toast.svelte';

  /** The presets most people want; the custom field covers everything else. */
  const PRESETS = [
    { days: 7, label: '7 days' },
    { days: 12, label: '12 days' },
    { days: 30, label: '30 days' },
    { days: 60, label: '60 days' },
    { days: 0, label: 'Never' }
  ];

  let customDays = $state(String(settings.trashRetentionDays));
  let cleaning = $state(false);

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      layout.settingsOpen = false;
      e.stopPropagation();
    }
  }

  function pick(days: number) {
    settings.setTrashRetentionDays(days);
    customDays = String(days);
  }

  function applyCustom() {
    const n = Math.round(Number(customDays));
    if (!Number.isFinite(n) || n < 0) {
      toast.push('warn', 'Days ek positive number hona chahiye (0 = kabhi nahi).');
      customDays = String(settings.trashRetentionDays);
      return;
    }
    settings.setTrashRetentionDays(n);
    toast.push(
      'info',
      n === 0 ? 'Trash kabhi auto-delete nahi hoga.' : `Trash ${n} din baad auto-delete hoga.`
    );
  }

  async function cleanExpired() {
    if (cleaning) return;
    cleaning = true;
    try {
      const db = await defaultDbPath();
      const removed = await purgeExpiredTrash(db, settings.trashRetentionDays);
      if (removed > 0)
        toast.push(
          'info',
          `${removed} purana trash record delete ho gaya — video files safe hain.`
        );
      else toast.push('info', 'Koi expired trash record nahi mila.');
    } catch (e) {
      toast.push('warn', `Clean nahi hua: ${e instanceof Error ? e.message : e}`);
    } finally {
      cleaning = false;
    }
  }

  const isBrowser = !isTauri();
</script>

<svelte:window onkeydown={onKey} />

{#if layout.settingsOpen}
  <div
    class="fixed inset-0 z-[410] grid place-items-center bg-black/70 p-6"
    role="dialog"
    aria-modal="true"
    aria-label="Settings"
  >
    <div
      class="max-h-full w-full max-w-lg overflow-auto rounded-2xl border border-nc-line-2 bg-nc-panel p-6 shadow-2xl"
    >
      <div class="mb-5 flex items-center gap-3">
        <span
          class="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-nc-brand to-nc-brand-dim text-[12px] font-black text-nc-bg"
          >⚙</span
        >
        <div>
          <h2 class="text-base font-bold">Settings</h2>
          <p class="text-[11px] text-nc-mut">Trash retention · app behaviour</p>
        </div>
        <div class="flex-1"></div>
        <button
          onclick={() => (layout.settingsOpen = false)}
          class="rounded-lg border border-nc-line px-3 py-1.5 text-xs text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
        >
          Close (Esc)
        </button>
      </div>

      <section class="rounded-xl border border-nc-line bg-nc-panel-2/50 p-4">
        <div class="flex items-baseline justify-between gap-3">
          <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">TRASH RETENTION</h3>
          <span class="text-[11px] text-nc-mut">
            {settings.trashNever
              ? 'Auto-delete: kabhi nahi'
              : `Auto-delete: ${settings.trashRetentionDays} din`}
          </span>
        </div>

        <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
          Trash ke records {settings.trashNever
            ? 'hamesha recoverable rahenge'
            : `${settings.trashRetentionDays} din baad automatically delete ho jayenge`}.
          <b class="text-nc-txt">Video files disk pe hamesha safe rahengi</b> — sirf app ka record hatta
          hai.
        </p>

        <div class="mt-3 flex flex-wrap gap-2">
          {#each PRESETS as p (p.days)}
            <button
              onclick={() => pick(p.days)}
              class="rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors duration-150
                     {settings.trashRetentionDays === p.days
                ? 'border-nc-brand bg-nc-brand/15 text-nc-brand'
                : 'border-nc-line bg-nc-panel text-nc-mut hover:border-nc-line-2 hover:text-nc-txt'}"
            >
              {p.label}
            </button>
          {/each}
        </div>

        <div class="mt-3 flex items-center gap-2">
          <label class="text-[11px] text-nc-mut" for="trash-days">Custom days</label>
          <input
            id="trash-days"
            type="number"
            min="0"
            max="3650"
            step="1"
            bind:value={customDays}
            onchange={applyCustom}
            class="w-24 rounded-md border border-nc-line bg-nc-bg px-2 py-1 text-[12px] text-nc-txt outline-none focus:border-nc-brand"
          />
          <span class="text-[11px] text-nc-mut-2">0 = kabhi nahi</span>
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-2">
          <button
            onclick={cleanExpired}
            disabled={cleaning || isBrowser}
            class="rounded-lg border border-nc-line px-3 py-1.5 text-[12px] text-nc-mut
                   transition-colors duration-150 hover:border-nc-line-2 hover:text-nc-txt disabled:opacity-50"
          >
            {cleaning ? 'Cleaning…' : 'Clean expired now'}
          </button>
          <button
            onclick={() => pick(TRASH_DAYS_DEFAULT)}
            class="rounded-lg border border-nc-line px-3 py-1.5 text-[12px] text-nc-mut
                   transition-colors duration-150 hover:border-nc-line-2 hover:text-nc-txt"
          >
            Reset to 12 days
          </button>
          {#if isBrowser}
            <span class="text-[10px] text-nc-mut-2">Desktop app me hi SQLite purge chalega.</span>
          {/if}
        </div>
      </section>
    </div>
  </div>
{/if}
