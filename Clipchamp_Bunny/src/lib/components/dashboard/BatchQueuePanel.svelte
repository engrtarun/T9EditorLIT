<script lang="ts">
  /**
   * BATCH TRANSCRIPT QUEUE (Case 4).
   *
   * "30 files ek saath" used to mean thirty separate imports, thirty clicks,
   * and no way to tell which file was being paid for. This card is the honest
   * answer: every file is a row with its own status, its own cost estimate and
   * a tick box, and the worker does one at a time — the queue position is the
   * store's real state, not a guessed percentage.
   *
   * It is mounted at the app root on purpose: the run keeps going while the
   * user edits or browses, and minimising leaves a one-line chip instead of
   * covering the editor.
   */
  import { batch } from '../../stores/batch.svelte';
  import { estimateForDuration } from '../../transcript-plan';
  import { batchPosition, batchProgress, batchTotals } from '../../batch-queue';
  import { pickVideos } from '../../ipc';
  import { fmtShort } from '../../utils';

  const totals = $derived(batchTotals(batch.items));
  const progress = $derived(batchProgress(batch.items));
  const current = $derived(batch.items.find((i) => i.id === batch.currentId) ?? null);
  const position = $derived(batch.currentId ? batchPosition(batch.items, batch.currentId) : null);

  /** Append more files to the queue that is already open. */
  async function addFiles() {
    const paths = await pickVideos();
    if (paths.length) batch.addPaths(paths);
  }

  const STATUS_LABEL: Record<string, string> = {
    probing: 'probing…',
    queued: 'queued',
    running: 'chal raha hai',
    done: 'done',
    cached: 'pehle se hai',
    failed: 'failed'
  };
</script>

{#if batch.open && batch.items.length}
  <div
    class="fixed right-4 bottom-[52px] z-40 w-[380px] max-w-[calc(100vw-2rem)] rounded-xl border
           border-nc-line bg-nc-panel/95 shadow-2xl backdrop-blur"
    role="region"
    aria-label="Batch transcript queue"
  >
    <div class="flex items-center gap-2 border-b border-nc-line px-3 py-2">
      <span class="text-[10px] font-bold tracking-widest text-nc-brand">BATCH TRANSCRIPT</span>
      <span class="font-mono text-[10px] text-nc-mut">
        {progress.done}/{progress.total}
        {#if position}· {position.at}/{position.of}{/if}
      </span>
      <div class="ml-auto flex items-center gap-1">
        <button
          onclick={() => void addFiles()}
          class="rounded border border-nc-line px-1.5 py-0.5 text-[10px] text-nc-mut
                 transition-colors hover:border-nc-line-2 hover:text-nc-txt"
          aria-label="Add more files to the batch queue"
        >
          + files
        </button>
        <button
          onclick={() => (batch.minimized = !batch.minimized)}
          class="rounded border border-nc-line px-1.5 py-0.5 text-[10px] text-nc-mut
                 transition-colors hover:border-nc-line-2 hover:text-nc-txt"
          aria-label={batch.minimized ? 'Expand batch queue' : 'Minimise batch queue'}
        >
          {batch.minimized ? '▲' : '▼'}
        </button>
        <button
          onclick={() => (batch.open = false)}
          class="rounded border border-nc-line px-1.5 py-0.5 text-[10px] text-nc-mut
                 transition-colors hover:border-nc-red/50 hover:text-nc-red"
          aria-label="Hide batch queue (the run keeps going)"
        >
          ✕
        </button>
      </div>
    </div>

    {#if !batch.minimized}
      {#if batch.running}
        <div class="border-b border-nc-line px-3 py-1.5">
          <div class="h-1 w-full overflow-hidden rounded-full bg-nc-panel-2">
            <div
              class="h-full rounded-full bg-nc-brand transition-[width] duration-300"
              style="width:{current && current.totalChunks
                ? Math.max(3, Math.round((current.doneChunks / current.totalChunks) * 100))
                : 5}%"
            ></div>
          </div>
          <p class="mt-1 truncate text-[10px] text-nc-mut-2">
            {current
              ? `${current.name} — chunk ${current.doneChunks}/${current.totalChunks || '…'}`
              : 'Agla file utha rahe hain…'}
          </p>
        </div>
      {/if}

      <ul class="max-h-[240px] overflow-y-auto px-1 py-1">
        {#each batch.items as item (item.id)}
          <li
            class="flex items-center gap-2 rounded-md px-2 py-1 text-[11px]
                   {item.status === 'running' ? 'bg-nc-brand/10' : ''}"
          >
            <input
              type="checkbox"
              checked={item.selected}
              disabled={item.status === 'running' || item.status === 'done'}
              onchange={() => batch.toggle(item.id)}
              aria-label="Include {item.name}"
              class="h-3 w-3 shrink-0 accent-nc-brand"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-nc-txt" title={item.path}>{item.name}</p>
              <p class="truncate text-[9.5px]">
                <span
                  class={item.status === 'failed'
                    ? 'text-nc-red'
                    : item.status === 'done' || item.status === 'cached'
                      ? 'text-nc-mut-2'
                      : 'text-nc-mut'}
                >
                  {STATUS_LABEL[item.status] ?? item.status}
                </span>
                {#if item.status === 'failed' && item.error}
                  <span class="text-nc-mut-2"> · {item.error}</span>
                {:else if item.status === 'queued' && item.durationSecs > 0}
                  <span class="text-nc-mut-2">
                    · {fmtShort(item.durationSecs)} ·
                    {estimateForDuration(item.durationSecs).calls} calls
                  </span>
                {:else if item.totalChunks > 0}
                  <span class="text-nc-mut-2">
                    · {item.doneChunks}/{item.totalChunks} chunks · {item.lines} lines
                  </span>
                {/if}
              </p>
            </div>
            <button
              onclick={() => batch.remove(item.id)}
              disabled={item.status === 'running'}
              class="shrink-0 rounded px-1 text-[10px] text-nc-mut-2 transition-colors
                     hover:text-nc-red disabled:opacity-30"
              aria-label="Remove {item.name} from the queue"
            >
              ✕
            </button>
          </li>
        {/each}
      </ul>

      <div class="border-t border-nc-line px-3 py-2">
        <p class="font-mono text-[9.5px] leading-relaxed text-nc-mut-2">
          {totals.files} file · ~{fmtShort(totals.audioSecs)} audio · {totals.calls} Whisper calls · ~{fmtShort(
            totals.etaSecs
          )} wait (estimate)
        </p>
        <div class="mt-1.5 flex flex-wrap items-center gap-2">
          {#if batch.running}
            <button
              onclick={() => batch.stopRun()}
              class="rounded border border-nc-red/40 bg-nc-red/10 px-2.5 py-1 text-[10.5px]
                     font-semibold text-nc-red transition-colors hover:bg-nc-red/20"
            >
              Rok do (ye file ke baad)
            </button>
          {:else}
            <button
              onclick={() => void batch.run()}
              disabled={totals.files === 0}
              class="rounded bg-nc-brand px-2.5 py-1 text-[10.5px] font-semibold text-white
                     transition-[filter] hover:brightness-110 disabled:opacity-40"
            >
              Queue chalao ({totals.files})
            </button>
          {/if}
          <button
            onclick={() => batch.clearFinished()}
            class="rounded border border-nc-line px-2 py-1 text-[10px] text-nc-mut
                   transition-colors hover:border-nc-line-2 hover:text-nc-txt"
          >
            Done hatao
          </button>
          <button
            onclick={() => batch.requeueFailed()}
            class="rounded border border-nc-line px-2 py-1 text-[10px] text-nc-mut
                   transition-colors hover:border-nc-line-2 hover:text-nc-txt"
          >
            Failed/cached dobara
          </button>
        </div>
        <p class="mt-1 text-[9.5px] leading-snug text-nc-mut-2">
          Ek waqt me ek file — Groq par 30 calls ek saath 429 hi dete hain. Har chunk SQLite me save
          hota hai, isliye beech me rokne par paisa dobara nahi lagta.
        </p>
      </div>
    {/if}
  </div>
{/if}
