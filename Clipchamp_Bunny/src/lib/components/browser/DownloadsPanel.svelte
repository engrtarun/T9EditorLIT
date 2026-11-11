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
  import { fmtSize } from '../../utils';
  import { openPath, revealPath } from '../../ipc';
  import { toast } from '../../stores/toast.svelte';
  import type { DownloadItem } from '../../types';

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

  /** A compact, local timestamp: "11 Nov, 15:42". Missing → "—". */
  function fmtWhen(ms: number): string {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  /** Wall-clock duration: "9m 12s", "1h 04m", "42s". Unknown → "—". */
  function fmtTaken(seconds: number): string {
    if (seconds <= 0) return '—';
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    if (m < 60) {
      const s = seconds % 60;
      return s ? `${m}m ${s}s` : `${m}m`;
    }
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }

  /** Seconds a live row took (finished) or has been running (running). */
  function tookOf(item: DownloadItem): number {
    const started = item.startedAt ?? 0;
    const ended = item.finishedAt ?? (item.status === 'running' ? Date.now() : 0);
    return started > 0 && ended >= started ? Math.round((ended - started) / 1000) : 0;
  }

  /**
   * Which row's full detail block is open. The one-line summary is always
   * visible on a terminal row; this adds the full path and the source URL.
   */
  let details = $state<string | null>(null);

  /**
   * Older downloads from the durable history. A row that is still in the
   * daemon's live list is already on screen above, so it is not repeated.
   */
  const past = $derived(
    downloads.history.filter((h) => !downloads.items.some((i) => i.id === h.id)).slice(0, 40)
  );

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

              {#if item.status !== 'running' && item.status !== 'paused'}
                <!-- When it ran and how long it took — "download history" is
                     these numbers, not just a row that disappears. -->
                <button
                  type="button"
                  onclick={() => (details = details === item.id ? null : item.id)}
                  class="mt-0.5 flex max-w-full items-center gap-1 text-left text-[10px] text-nc-mut-2 hover:text-nc-mut"
                  aria-expanded={details === item.id}
                  title="Download detail — start, finish, time, path, URL"
                >
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    class="shrink-0 transition-transform"
                    class:rotate-90={details === item.id}
                  >
                    <path d="M4 2l4 4-4 4" />
                  </svg>
                  <span class="truncate">
                    {fmtWhen(item.startedAt ?? 0)} → {fmtWhen(item.finishedAt ?? 0)}
                    · {fmtTaken(tookOf(item))}
                    {#if item.totalBytes > 0 && tookOf(item) > 0}
                      · avg {fmtSpeed(Math.round(item.totalBytes / tookOf(item)))}
                    {/if}
                  </span>
                </button>
              {/if}

              {#if details === item.id}
                <dl
                  class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 rounded bg-nc-panel-2/60 px-2 py-1.5 text-[10px] leading-snug"
                >
                  <dt class="text-nc-mut-2">Started</dt>
                  <dd class="text-nc-mut">{fmtWhen(item.startedAt ?? 0)}</dd>
                  <dt class="text-nc-mut-2">Finished</dt>
                  <dd class="text-nc-mut">{fmtWhen(item.finishedAt ?? 0)}</dd>
                  <dt class="text-nc-mut-2">Took</dt>
                  <dd class="text-nc-mut">{fmtTaken(tookOf(item))}</dd>
                  <dt class="text-nc-mut-2">Path</dt>
                  <dd class="break-all text-nc-mut">{item.path || '—'}</dd>
                  <dt class="text-nc-mut-2">URL</dt>
                  <dd class="break-all text-nc-mut">{item.url}</dd>
                </dl>
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

    <!--
      History is the durable half. The daemon is a queue, not an archive: it
      drops a finished row 15 minutes after it completes, which is why old
      downloads kept "auto-cleaning". The store writes every terminal row to
      localStorage the moment it finishes, so this list is the user's, and
      only they clear it.
    -->
    <div class="border-t border-nc-line/60">
      <div class="flex h-8 items-center justify-between px-3">
        <button
          type="button"
          onclick={() => (downloads.showHistory = !downloads.showHistory)}
          class="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-nc-mut uppercase hover:text-nc-txt"
          aria-expanded={downloads.showHistory}
        >
          <svg
            width="8"
            height="8"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            class="transition-transform"
            class:rotate-90={downloads.showHistory}
          >
            <path d="M4 2l4 4-4 4" />
          </svg>
          History
          {#if downloads.history.length > 0}
            <span class="rounded-full bg-nc-panel-2 px-1.5 text-[10px] font-bold text-nc-mut"
              >{downloads.history.length}</span
            >
          {/if}
        </button>
        {#if downloads.showHistory && downloads.history.length > 0}
          <button
            type="button"
            onclick={() => downloads.clearHistory()}
            class="grid h-6 w-6 place-items-center rounded text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
            title="Download history clear karo (files disk par rehti hain)"
            aria-label="Clear download history"
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
      </div>

      {#if downloads.showHistory}
        {#if past.length === 0}
          <p class="px-3 pb-3 text-center text-[11px] text-nc-mut">
            Abhi koi purana download nahi — jo complete hoga, yahin rehta hai.
          </p>
        {:else}
          <ul class="max-h-[200px] overflow-y-auto border-t border-nc-line/40">
            {#each past as h (h.id)}
              <li
                class="flex items-start gap-3 border-b border-nc-line/30 px-3 py-1.5 last:border-0"
              >
                <span
                  class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-nc-panel-2 text-nc-mut"
                  aria-hidden="true"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                  >
                    {#if h.status === 'done'}
                      <path d="M5 13l4 4L19 7" />
                    {:else}
                      <path d="M12 8v5M12 16h.01M4 20h16L12 4z" />
                    {/if}
                  </svg>
                </span>
                <div class="min-w-0 flex-1">
                  {#if h.path}
                    <button
                      type="button"
                      onclick={() =>
                        void revealPath(h.path).then((ok) => {
                          if (!ok) toast.push('warn', 'File abhi disk par nahi — ' + h.path);
                        })}
                      class="block max-w-full truncate text-left text-[11px] text-nc-txt hover:underline"
                      title={h.path}
                    >
                      {h.filename}
                    </button>
                  {:else}
                    <span class="block truncate text-[11px] text-nc-txt">{h.filename}</span>
                  {/if}
                  <div class="truncate text-[10px] text-nc-mut-2">
                    {fmtWhen(h.startedAt)} → {fmtWhen(h.finishedAt)}
                    · {fmtTaken(h.seconds)}
                    {#if h.avgBps > 0}
                      · avg {fmtSpeed(h.avgBps)}
                    {/if}
                    · {fmtSize(h.bytes)}
                  </div>
                </div>
                <span
                  class="shrink-0 text-[10px] {h.status === 'done'
                    ? 'text-nc-mut-2'
                    : 'text-nc-red'}">{h.status}</span
                >
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  </div>
{/if}
