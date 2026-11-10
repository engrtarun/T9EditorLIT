<script lang="ts">
  /**
   * The downloads panel — Firefox's download button popover, ours is a
   * slide-up bar at the bottom of the browser view.
   *
   * Every number on it comes from the Go daemon's counters (bytes received,
   * sliding-window speed, segments in flight) — the UI never counts anything
   * itself, so a paused download's bar stops where the writer stopped.
   *
   * A finished row is a *file*, not just a line of text: it says where it
   * landed and offers both "folder me dikhao" (reveal in Explorer) and
   * "kholo" (hand it to the app that owns the extension). The daemon already
   * reports the absolute `path`, so neither needs a second round trip.
   */
  import { downloads } from '../../stores/downloads.svelte';
  import { ublock } from '../../stores/ublock.svelte';
  import { fmtSize } from '../../utils';
  import { openPath, pickFolder, revealPath } from '../../ipc';
  import { toast } from '../../stores/toast.svelte';
  import type { DownloadItem } from '../../types';

  /** The gear popover (connections, folder, auto-resume, notify). */
  let settingsOpen = $state(false);
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

  /** Bytes/s → "4.2 MB/s". */
  function fmtSpeed(bps: number): string {
    if (bps <= 0) return '—';
    return `${fmtSize(bps)}/s`;
  }

  /** Seconds left → "12s" / "3m" / "1h"; unknown → "—". */
  function eta(item: { totalBytes: number; receivedBytes: number; speedBps: number }): string {
    if (item.speedBps <= 0 || item.totalBytes <= 0 || item.receivedBytes >= item.totalBytes)
      return '—';
    const s = Math.round((item.totalBytes - item.receivedBytes) / item.speedBps);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }

  function pct(item: { totalBytes: number; receivedBytes: number }): number {
    if (item.totalBytes <= 0) return 0;
    return Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100));
  }

  /** The folder part of a path — what "show in folder" opens. */
  function folderOf(p: string): string {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i > 0 ? p.slice(0, i) : p;
  }

  async function reveal(item: DownloadItem): Promise<void> {
    const ok = await revealPath(item.path);
    if (!ok) toast.push('warn', 'Explorer nahi khul paya — path: ' + item.path);
  }

  async function open(item: DownloadItem): Promise<void> {
    const ok = await openPath(item.path);
    if (!ok) toast.push('warn', 'File nahi khul payi — folder me dikhao se try karo');
  }

  /** Newest finished file's folder, for the panel-level shortcut. */
  const lastFolder = $derived.by(() => {
    const done = downloads.items.find((i) => i.status === 'done' && i.path);
    return done ? folderOf(done.path) : null;
  });
</script>

{#if downloads.open}
  <div
    class="shrink-0 border-t border-nc-line bg-nc-panel shadow-[0_-8px_24px_rgba(0,0,0,0.35)]"
    aria-label="Downloads"
  >
    <div class="flex h-8 items-center justify-between border-b border-nc-line/60 px-3">
      <span
        class="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-nc-mut uppercase"
      >
        Downloads
        {#if downloads.activeCount > 0}
          <span class="rounded-full bg-nc-brand/25 px-1.5 text-nc-brand"
            >{downloads.activeCount} active</span
          >
        {/if}
      </span>
      <div class="flex items-center gap-1">
        {#if downloads.finishedCount > 0}
          <button
            type="button"
            onclick={() => downloads.clearFinished()}
            class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
            title="Finished rows hatao (files disk par rehti hain)"
            aria-label="Clear finished downloads"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
            >
              <path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" />
            </svg>
          </button>
        {/if}
        <button
          type="button"
          onclick={() => (settingsOpen = !settingsOpen)}
          class="grid h-6 w-6 place-items-center rounded {settingsOpen
            ? 'bg-nc-panel-2 text-nc-brand'
            : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
          title="Download settings (connections, folder, auto-resume)"
          aria-label="Download settings"
          aria-expanded={settingsOpen}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
          >
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
            />
          </svg>
        </button>
        {#if lastFolder}
          <button
            type="button"
            onclick={() => void revealPath(lastFolder ?? '')}
            class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
            title="Downloads folder kholo (Explorer)"
            aria-label="Open downloads folder"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
            >
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </button>
        {/if}
        <button
          type="button"
          onclick={() => (downloads.open = false)}
          class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
          aria-label="Hide downloads"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>
    </div>

    {#if settingsOpen}
      <!-- Every field here is stored in SQLite by Rust and pushed to the Go
           daemon, so it survives both the app and a daemon restart. The hint
           about "next download" is deliberate: a live split is never re-planned
           under its writers. -->
      <div
        class="border-b border-nc-line/50 bg-nc-panel-2/40 px-3 py-2.5"
        aria-label="Download settings"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-1">
          <span class="text-[11px] font-semibold text-nc-txt">Download settings</span>
          <span class="text-[10px] text-nc-mut-2">SQLite me save · naye download par lagta hai</span
          >
        </div>

        <div class="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2">
          <label class="block">
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
              Range support ho to zyada sockets = zyada speed. Host mana kare to daemon khud 1
              socket par chalta hai.
            </span>
          </label>

          <div class="block">
            <span class="text-[11px] text-nc-mut">Save folder</span>
            <div class="mt-1 flex items-center gap-1">
              <span
                class="min-w-0 flex-1 truncate rounded bg-nc-panel px-2 py-1 text-[11px] text-nc-txt"
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
              class="relative h-3.5 w-6 rounded-full transition-colors {downloads.settings
                .autoResume
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
            title="Download pura hone par toast"
          >
            <span
              class="relative h-3.5 w-6 rounded-full transition-colors {downloads.settings
                .notifyDone
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
            Done hone par batao
          </button>

          <span class="text-[10px] text-nc-mut-2">
            Background me chalti rehti hai jab tak tum cancel na karo.
          </span>
        </div>

        <div
          class="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-nc-line/40 pt-2"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span
                class="rounded bg-nc-brand/20 px-1 py-0.5 text-[9px] font-semibold tracking-wide text-nc-brand uppercase"
                >ad blocker</span
              >
              <span class="text-[11px] font-semibold text-nc-txt">uBlock Origin</span>
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
              {/if}
            </div>
            <p class="mt-0.5 max-w-[52ch] text-[10px] leading-snug text-nc-mut-2">
              {#if !ublock.reachable}
                Daemon se baat nahi ho rahi — status purana ho sakta hai.
              {:else if ublock.status?.updating}
                GitHub se naya release check ho raha hai…
              {:else if !ublock.status?.installed}
                Abhi install nahi hua — daemon pehla check kar raha hai.
              {:else}
                By default on · auto-update har 6 ghante · ads aur trackers block.
                {#if ublock.runtime === 'missing'}
                  WebView2 ne abhi load nahi kiya{ublock.runtimeError
                    ? `: ${ublock.runtimeError}`
                    : ''}.
                {/if}
              {/if}
            </p>
            {#if ublock.status?.error}
              <p class="mt-0.5 max-w-[52ch] text-[10px] leading-snug text-nc-red">
                {ublock.status.error}
              </p>
            {/if}
          </div>
          <button
            type="button"
            onclick={() => void ublock.updateNow()}
            disabled={ublock.status?.updating}
            class="shrink-0 rounded bg-nc-panel px-2 py-1 text-[11px] font-medium text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-50"
            title="Abhi GitHub check karo (auto-update apne aap chalta rehta hai)"
          >
            {ublock.status?.updating ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>
    {/if}

    {#if !downloads.reachable && downloads.items.length > 0}
      <!-- The daemon owns the bytes. When it is unreachable the numbers above
           would sit still forever with no explanation, which reads as "mera
           download mar gaya" — say what is actually happening instead. -->
      <p class="border-b border-nc-line/40 bg-nc-brand/10 px-3 py-1.5 text-[11px] text-nc-brand">
        Daemon se connection nahi — app use ~20 second me restart kar deta hai, phir row wahin se
        chalti hai.
      </p>
    {/if}

    {#if downloads.failed.length > 0}
      <ul class="border-b border-nc-line/40">
        {#each downloads.failed as fail (fail.id)}
          <li class="flex items-start gap-3 px-3 py-2">
            <span
              class="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-nc-red/20 text-[13px] font-bold text-nc-red"
              aria-hidden="true">!</span
            >
            <div class="min-w-0 flex-1">
              <div class="truncate text-[12px] text-nc-txt" title={fail.filename}>
                {fail.filename}
              </div>
              <div class="text-[11px] leading-snug text-nc-red">{fail.error}</div>
            </div>
            <button
              type="button"
              onclick={() => downloads.dismissFailed(fail.id)}
              class="grid h-6 w-6 shrink-0 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
              title="Remove from list"
              aria-label="Dismiss failed download"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
              >
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if downloads.items.length === 0 && downloads.failed.length === 0}
      <p class="px-3 py-4 text-center text-[12px] text-nc-mut">
        Abhi kuch download nahi ho raha — browser toolbar ke ⬇ se shuru karo
      </p>
    {:else if downloads.items.length > 0}
      <ul class="max-h-[230px] overflow-y-auto">
        {#each downloads.items as item (item.id)}
          <li class="flex items-start gap-3 border-b border-nc-line/40 px-3 py-2 last:border-0">
            <span
              class="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-nc-panel-2 text-nc-mut"
              aria-hidden="true"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
              >
                {#if item.status === 'done'}
                  <path d="M5 13l4 4L19 7" />
                {:else}
                  <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
                {/if}
              </svg>
            </span>

            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-2">
                <button
                  type="button"
                  onclick={() => (item.status === 'done' ? void reveal(item) : undefined)}
                  class="min-w-0 truncate text-left text-[12px] text-nc-txt {item.status === 'done'
                    ? 'hover:underline'
                    : 'cursor-default'}"
                  title={item.path ? item.path : item.filename}
                >
                  {item.filename}
                </button>
                <span class="shrink-0 text-[11px] text-nc-mut">
                  {#if item.status === 'running'}
                    {#if item.phase === 'resuming'}
                      <span
                        class="text-nc-brand"
                        title="Server ne Range ignore kiya — disk par
                        pehle se maujood prefix dobara padha ja raha hai, phir naye bytes aage
                        badhenge">prefix dobara padh raha hai…</span
                      >
                    {:else}
                      {fmtSpeed(item.speedBps)} · {eta(item)} left
                    {/if}
                  {:else if item.status === 'done'}
                    {fmtSize(item.totalBytes)} · done
                  {:else if item.status === 'error'}
                    <span class="text-nc-red">{item.error ?? 'failed'}</span>
                  {:else}
                    {item.status}
                  {/if}
                </span>
              </div>

              {#if item.status === 'running' || item.status === 'paused' || item.status === 'error'}
                <div class="mt-1 flex items-center gap-2">
                  <div class="h-1 flex-1 overflow-hidden rounded-full bg-nc-line">
                    <div
                      class="h-full rounded-full transition-[width] duration-300 {item.status ===
                      'paused'
                        ? 'bg-nc-mut'
                        : item.status === 'error'
                          ? 'bg-nc-red/70'
                          : 'bg-nc-brand'}"
                      style="width: {pct(item)}%"
                    ></div>
                  </div>
                  <span class="w-9 shrink-0 text-right text-[10px] text-nc-mut">{pct(item)}%</span>
                  <span class="shrink-0 text-[10px] text-nc-mut/80">
                    {fmtSize(item.receivedBytes)} / {fmtSize(item.totalBytes)}
                    {#if item.segments > 1}
                      <span class="rounded bg-nc-brand/20 px-1 text-nc-brand">×{item.segments}</span
                      >
                    {/if}
                    {#if (item.rereadBytes ?? 0) > 0}
                      <span
                        class="rounded bg-nc-panel-2 px-1"
                        title="Host Range ignore karta hai, isliye resume par itna prefix dobara padha gaya"
                        >↻ {fmtSize(item.rereadBytes ?? 0)}</span
                      >
                    {/if}
                  </span>
                </div>
              {/if}

              {#if item.status !== 'running' && item.path}
                <!-- where it actually landed, so "kahan gaya?" never needs guessing -->
                <button
                  type="button"
                  onclick={() => void reveal(item)}
                  class="mt-0.5 block max-w-full truncate text-left text-[10px] text-nc-mut-2 hover:text-nc-mut hover:underline"
                  title={item.path}
                >
                  {folderOf(item.path)}
                </button>
              {/if}
            </div>

            <!-- row actions: pause / resume / folder / open / cancel -->
            <div class="flex shrink-0 items-center gap-1">
              {#if item.status !== 'done' && item.path}
                <!-- a running download is a `.part` on disk; showing it is how
                     the user sees the daemon really is writing to Downloads -->
                <button
                  type="button"
                  onclick={() => void reveal(item)}
                  class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
                  title="Folder me dikhao (.part file)"
                  aria-label="Show this download in the folder"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                  >
                    <path
                      d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
                    />
                  </svg>
                </button>
              {/if}
              {#if item.status === 'running'}
                <button
                  type="button"
                  onclick={() => downloads.act(item.id, 'pause')}
                  class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
                  title="Pause"
                  aria-label="Pause download"
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                    <rect x="2" y="1.5" width="3" height="9" rx="1" /><rect
                      x="7"
                      y="1.5"
                      width="3"
                      height="9"
                      rx="1"
                    />
                  </svg>
                </button>
              {:else if item.status === 'paused'}
                <button
                  type="button"
                  onclick={() => downloads.act(item.id, 'resume')}
                  class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
                  title="Resume"
                  aria-label="Resume download"
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
                    <path d="M3 1.5l7.5 4.5L3 10.5z" />
                  </svg>
                </button>
              {:else if item.status === 'error'}
                <!-- Retry is a resume: the daemon keeps every byte it reached,
                     so a row that died at 98 MB of 1 GB starts at 98 MB -->
                <button
                  type="button"
                  onclick={() => downloads.act(item.id, 'resume')}
                  class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
                  title="Retry (wahin se, jahan ruka tha)"
                  aria-label="Retry download"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path d="M21 12a9 9 0 1 1-3-6.7" />
                    <path d="M21 3v6h-6" />
                  </svg>
                </button>
              {:else if item.status === 'done'}
                <button
                  type="button"
                  onclick={() => void reveal(item)}
                  class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
                  title="Folder me dikhao"
                  aria-label="Show in folder"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                  >
                    <path
                      d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  onclick={() => void open(item)}
                  class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
                  title="File kholo"
                  aria-label="Open file"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                  >
                    <path
                      d="M14 4h6v6M20 4l-9 9M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"
                    />
                  </svg>
                </button>
              {/if}

              {#if item.status === 'running' || item.status === 'paused'}
                <button
                  type="button"
                  onclick={() => downloads.act(item.id, 'cancel')}
                  class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-red/30 hover:text-nc-txt"
                  title="Cancel"
                  aria-label="Cancel download"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                  >
                    <path d="M2 2l8 8M10 2l-8 8" />
                  </svg>
                </button>
              {:else}
                <button
                  type="button"
                  onclick={() => downloads.dismiss(item.id)}
                  class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
                  title="Remove from list"
                  aria-label="Remove from list"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                  >
                    <path d="M2 2l8 8M10 2l-8 8" />
                  </svg>
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
