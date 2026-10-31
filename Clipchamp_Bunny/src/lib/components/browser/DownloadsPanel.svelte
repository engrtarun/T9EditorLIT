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

    {#if downloads.items.length === 0}
      <p class="px-3 py-4 text-center text-[12px] text-nc-mut">
        Abhi kuch download nahi ho raha — browser toolbar ke ⬇ se shuru karo
      </p>
    {:else}
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
                    {fmtSpeed(item.speedBps)} · {eta(item)} left
                  {:else if item.status === 'done'}
                    {fmtSize(item.totalBytes)} · done
                  {:else if item.status === 'error'}
                    <span class="text-nc-red">{item.error ?? 'failed'}</span>
                  {:else}
                    {item.status}
                  {/if}
                </span>
              </div>

              {#if item.status === 'running' || item.status === 'paused'}
                <div class="mt-1 flex items-center gap-2">
                  <div class="h-1 flex-1 overflow-hidden rounded-full bg-nc-line">
                    <div
                      class="h-full rounded-full transition-[width] duration-300 {item.status ===
                      'paused'
                        ? 'bg-nc-mut'
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
                  </span>
                </div>
              {:else if item.path}
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
