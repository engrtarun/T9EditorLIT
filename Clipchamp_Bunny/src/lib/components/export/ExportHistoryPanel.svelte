<script lang="ts">
  import { listExportHistory, openPath, revealPath } from '../../ipc';
  import type { ExportHistoryRow } from '../../types';
  import type { ExportCaps } from '../../export-presets';
  import { fmtSize, fmtHuman } from '../../utils';

  let { open = $bindable(false), caps }: { open?: boolean; caps: ExportCaps } = $props();

  let rows = $state<ExportHistoryRow[] | null>(null);
  let failed = $state(false);

  $effect(() => {
    if (!open) return;
    rows = null;
    failed = false;
    listExportHistory(50)
      .then((r) => {
        rows = r;
      })
      .catch(() => {
        failed = true;
      });
  });

  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open = false;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function fmtDate(ms: number): string {
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return '';
    }
  }

  function nameOf(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    onclick={(e) => {
      if (e.target === e.currentTarget) open = false;
    }}
    onkeydown={(e) => {
      if (e.key === 'Escape') open = false;
    }}
    role="button"
    tabindex="-1"
    aria-label="Close export history"
  >
    <div
      class="flex w-[min(640px,92vw)] max-h-[80vh] flex-col overflow-hidden rounded-2xl border border-nc-line bg-nc-panel shadow-2xl shadow-black/60"
      role="dialog"
      aria-modal="true"
      aria-label="Export History"
      tabindex="-1"
    >
      <div class="flex shrink-0 items-center gap-3 border-b border-nc-line px-5 py-3.5">
        <svg
          viewBox="0 0 24 24"
          class="h-4.5 w-4.5 text-nc-brand"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <h2 class="text-sm font-bold">Export History</h2>
        <span class="text-[10px] text-nc-mut-2">
          {rows && rows.length > 0 ? `${rows.length} export${rows.length === 1 ? '' : 's'}` : ''}
        </span>
        <div class="flex-1"></div>
        <button
          type="button"
          onclick={() => (open = false)}
          class="rounded-md px-2 py-1 text-[11px] text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
        >
          Close
        </button>
      </div>

      <div class="nc-scroll min-h-0 flex-1 p-4">
        {#if !caps.history}
          <div class="flex flex-col items-center gap-2 py-10 text-center">
            <p class="text-xs font-semibold text-nc-mut">History engine pending</p>
            <p class="max-w-sm text-[11px] leading-relaxed text-nc-mut-2">
              Jab engine me export_history land karega (EXPORT.md B1-1), tab yahan sab exports
              dikhenge — status, size, duration aur Show in folder.
            </p>
          </div>
        {:else if failed}
          <p class="py-6 text-center text-[11px] text-nc-red">
            History load nahi hui — ek baar retry karo.
          </p>
        {:else if rows === null}
          <p class="py-6 text-center text-[11px] text-nc-mut-2">Loading…</p>
        {:else if rows.length === 0}
          <p class="py-6 text-center text-[11px] text-nc-mut-2">Abhi tak koi export nahi.</p>
        {:else}
          <ul class="space-y-2">
            {#each rows as row (row.id)}
              <li
                class="flex items-start gap-3 rounded-xl border border-nc-line bg-nc-panel-2/60 px-3 py-2.5"
              >
                <span
                  class="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-nc-panel text-[9px] font-bold uppercase tracking-wide text-nc-mut"
                >
                  {row.format === 'mp3' ? 'MP3' : row.format === 'gif' ? 'GIF' : 'MP4'}
                </span>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-xs font-semibold text-nc-txt">{nameOf(row.path)}</p>
                  <p class="truncate text-[10px] text-nc-mut-2" title={row.path}>{row.path}</p>
                  <p class="mt-1 font-mono text-[10px] text-nc-mut">
                    {fmtSize(row.sizeBytes)} · {fmtHuman(row.durationSecs)} · {row.resolution}
                    · {fmtDate(row.createdAt)}
                  </p>
                  {#if row.status === 'failed' && row.error}
                    <p class="mt-1 text-[10px] text-nc-red">failed: {row.error}</p>
                  {:else if row.status === 'cancelled'}
                    <p class="mt-1 text-[10px] text-nc-amber">cancelled</p>
                  {/if}
                </div>
                <div class="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    onclick={() => revealPath(row.path)}
                    class="rounded-md border border-nc-line bg-nc-panel px-2 py-1 text-[10px] text-nc-mut hover:border-nc-brand/50 hover:text-nc-txt"
                    title="Explorer me dikhao"
                  >
                    Folder
                  </button>
                  <button
                    type="button"
                    onclick={() => openPath(row.path)}
                    class="rounded-md border border-nc-line bg-nc-panel px-2 py-1 text-[10px] text-nc-mut hover:border-nc-brand/50 hover:text-nc-txt"
                    title="Play"
                  >
                    Play
                  </button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </div>
{/if}
