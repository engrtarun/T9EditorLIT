<script lang="ts">
  /**
   * The browser's real settings, in one place: the downloader knobs that live
   * in SQLite + the ad blocker that lives on disk and in WebView2.
   *
   * This used to be a gear inside the Downloads panel, which made the ad
   * blocker impossible to find unless a download was already open. It now
   * renders inside the hamburger Menu, next to the rest of the browser tools.
   */
  import { downloads } from '../../stores/downloads.svelte';
  import { ublock } from '../../stores/ublock.svelte';
  import { pickFolder, appNotify } from '../../ipc';
  import { toast } from '../../stores/toast.svelte';

  /** Range dragging has to feel immediate; SQLite is written on release. */
  let connDraft = $state<number | null>(null);
  const connections = $derived(connDraft ?? downloads.settings.connections);

  async function chooseFolder(): Promise<void> {
    const dir = await pickFolder();
    if (!dir) return;
    try {
      await downloads.persistSettings({ saveDir: dir });
      toast.push('cut', 'Naya download folder set ho gaya', 2200);
    } catch {
      /* persistSettings already showed the reason */
    }
  }

  async function setConnections(value: number): Promise<void> {
    try {
      await downloads.persistSettings({ connections: value });
    } catch {
      /* persistSettings already showed the reason */
    } finally {
      connDraft = null;
    }
  }

  /**
   * Fire one real toast and report the native error when it fails.
   *
   * "Notification nahi aa raha" is impossible to debug from the UI when the
   * send is fire-and-forget: the button either shows a toast in the Windows
   * notification centre or says exactly what the plugin refused.
   */
  async function testNotification(): Promise<void> {
    try {
      await appNotify(
        'T9 Editor LIT — test notification',
        'Agar ye dikh raha hai to download notifications bhi aayenge.'
      );
      toast.push('info', '📣 Test notification bheja — Windows notification centre dekho');
    } catch (err) {
      toast.push(
        'warn',
        `Notification nahi chala: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
</script>

<div class="grid gap-3">
  <!-- ── Add-ons: uBlock Origin Lite ────────────────────────────────────── -->
  <section aria-label="Add-ons">
    <div class="flex items-center gap-1.5">
      <span
        class="rounded bg-nc-brand/20 px-1 py-0.5 text-[9px] font-semibold tracking-wide text-nc-brand uppercase"
        >add-on</span
      >
      <span class="text-[11px] font-semibold text-nc-txt">uBlock Origin Lite</span>
      {#if ublock.version}
        <span class="text-[10px] text-nc-mut-2">v{ublock.version}</span>
      {/if}
      {#if ublock.runtime === 'loaded'}
        <span
          class="rounded bg-nc-green/15 px-1 text-[9px] font-semibold text-nc-green"
          title="WebView2 ki apni extension list se — folder hone se nahi">loaded</span
        >
      {:else if ublock.runtime === 'missing'}
        <span
          class="rounded bg-nc-red/15 px-1 text-[9px] font-semibold text-nc-red"
          title={ublock.runtimeError ?? 'WebView2 ne extension list me nahi dikhaya'}
          >not loaded</span
        >
      {:else}
        <span
          class="rounded bg-nc-panel-2 px-1 text-[9px] font-semibold text-nc-mut"
          title="Pehla tab khulne par WebView2 batayega ki extension load hua ya nahi"
          >tab kholne par pata chalega</span
        >
      {/if}
      <button
        type="button"
        onclick={() => void ublock.updateNow()}
        disabled={ublock.status?.updating}
        class="ml-auto shrink-0 rounded bg-nc-panel-2 px-2 py-1 text-[10px] font-medium text-nc-mut hover:bg-nc-line hover:text-nc-txt disabled:opacity-50"
        title="Abhi GitHub check karo (auto-update apne aap chalta rehta hai)"
      >
        {ublock.status?.updating ? 'Checking…' : 'Check now'}
      </button>
    </div>
    <p class="mt-1 max-w-[52ch] text-[10px] leading-snug text-nc-mut-2">
      {#if !ublock.reachable}
        Daemon se baat nahi ho rahi — status purana ho sakta hai.
      {:else if ublock.status?.updating}
        GitHub se naya release check ho raha hai…
      {:else if !ublock.status?.installed}
        Abhi install nahi hua — daemon pehla check kar raha hai.
      {:else}
        Default on · auto-update har 6 ghante · ads aur trackers block.
        {#if ublock.runtime === 'missing'}
          WebView2 ne abhi load nahi kiya{ublock.runtimeError ? `: ${ublock.runtimeError}` : ''}.
        {/if}
      {/if}
    </p>
    {#if ublock.status?.error}
      <p class="mt-0.5 max-w-[52ch] text-[10px] leading-snug text-nc-red">
        {ublock.status.error}
      </p>
    {/if}
  </section>

  <!-- ── Downloader ─────────────────────────────────────────────────────── -->
  <section class="border-t border-nc-line/40 pt-3" aria-label="Download settings">
    <div class="flex flex-wrap items-baseline justify-between gap-1">
      <span class="text-[11px] font-semibold text-nc-txt">Download settings</span>
      <span class="text-[10px] text-nc-mut-2">SQLite me save · naye download par lagta hai</span>
    </div>

    <label class="mt-2 block">
      <span class="flex items-baseline justify-between text-[11px] text-nc-mut">
        <span>Connections <span class="text-nc-mut-2">(per download)</span></span>
        <span class="font-semibold text-nc-brand">{connections}</span>
      </span>
      <input
        type="range"
        min="1"
        max="16"
        step="1"
        value={connections}
        disabled={downloads.savingSettings}
        oninput={(e) => (connDraft = Number(e.currentTarget.value))}
        onchange={(e) => void setConnections(Number(e.currentTarget.value))}
        class="mt-1 w-full accent-nc-brand"
        aria-label="Parallel connections per download"
      />
      <span class="block text-[10px] leading-snug text-nc-mut-2">
        Range support ho to zyada sockets = zyada speed. Host mana kare to daemon khud 1 socket par
        chalta hai.
      </span>
    </label>

    <div class="mt-2 block">
      <span class="text-[11px] text-nc-mut">Save folder</span>
      <div class="mt-1 flex items-center gap-1">
        <span
          class="min-w-0 flex-1 truncate rounded bg-nc-panel-2 px-2 py-1 text-[11px] text-nc-txt"
          title={downloads.settings.saveDir}>{downloads.settings.saveDir || 'Downloads'}</span
        >
        <button
          type="button"
          onclick={() => void chooseFolder()}
          class="shrink-0 rounded bg-nc-brand/20 px-2 py-1 text-[11px] font-medium text-nc-brand hover:bg-nc-brand/30"
          title="Folder chuno"
        >
          Badlo
        </button>
      </div>
      <span class="block text-[10px] leading-snug text-nc-mut-2">
        File yahin likhi jayegi. Chal rahi download apne purane folder me hi rehti hai.
      </span>
    </div>

    <div class="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
      <button
        type="button"
        role="switch"
        aria-checked={downloads.settings.autoResume}
        onclick={() =>
          void downloads.persistSettings({ autoResume: !downloads.settings.autoResume })}
        class="flex items-center gap-1.5 text-[11px] text-nc-mut hover:text-nc-txt"
        title="Daemon restart ke baad adhoori download khud chalti rahegi"
      >
        <span
          class="relative h-3.5 w-6 rounded-full transition-colors {downloads.settings.autoResume
            ? 'bg-nc-brand'
            : 'bg-nc-line'}"
        >
          <span
            class="absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all {downloads
              .settings.autoResume
              ? 'left-3'
              : 'left-0.5'}"
          ></span>
        </span>
        Auto-resume
      </button>

      <button
        type="button"
        role="switch"
        aria-checked={downloads.settings.notifyDone}
        onclick={() =>
          void downloads.persistSettings({ notifyDone: !downloads.settings.notifyDone })}
        class="flex items-center gap-1.5 text-[11px] text-nc-mut hover:text-nc-txt"
        title="Download shuru hone par, aur 1 GB se bada ho to poora hone par bhi OS notification"
      >
        <span
          class="relative h-3.5 w-6 rounded-full transition-colors {downloads.settings.notifyDone
            ? 'bg-nc-brand'
            : 'bg-nc-line'}"
        >
          <span
            class="absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all {downloads
              .settings.notifyDone
              ? 'left-3'
              : 'left-0.5'}"
          ></span>
        </span>
        Start + done notify
      </button>
    </div>
    <p class="mt-1 text-[10px] text-nc-mut-2">
      Background me chalti rehti hai jab tak tum cancel na karo.
    </p>
    <button
      type="button"
      onclick={() => void testNotification()}
      class="mt-2 rounded bg-nc-panel-2 px-2 py-1 text-[10px] font-medium text-nc-mut hover:bg-nc-panel-2/70 hover:text-nc-txt"
      title="Windows notification abhi test karo — fail ho to reason toast me aayega"
    >
      Test notification
    </button>
  </section>
</div>
