<script lang="ts">
  /**
   * The history panel — Firefox's Ctrl+H, as a slide-up bar above the page.
   *
   * The log is the store's bounded `historyLog` (newest first, consecutive
   * duplicates collapsed): address-bar submissions, in-page navigations and
   * history jumps all land in it. Ctrl+Shift+Del empties it and wipes the
   * active page's webview profile; the ✕ here only closes the panel.
   */
  import { browser } from '../../stores/browser.svelte';

  function when(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

{#if browser.historyOpen}
  <div
    class="shrink-0 border-t border-nc-line bg-nc-panel shadow-[0_-8px_24px_rgba(0,0,0,0.35)]"
    aria-label="History"
  >
    <div class="flex h-8 items-center justify-between border-b border-nc-line/60 px-3">
      <span
        class="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-nc-mut uppercase"
      >
        History
        <span class="rounded-full bg-nc-panel-2 px-1.5 text-nc-mut-2"
          >{browser.historyLog.length}</span
        >
      </span>
      <div class="flex items-center gap-1">
        <button
          type="button"
          onclick={() => browser.clearHistory()}
          class="rounded-md px-2 py-0.5 text-[10px] text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt"
          title="History saaf karo (Ctrl + Shift + Del)"
        >
          Saaf karo
        </button>
        <button
          type="button"
          onclick={() => browser.toggleHistory()}
          class="grid h-5 w-5 place-items-center rounded-md text-[11px] text-nc-mut transition-colors hover:bg-nc-panel-2 hover:text-nc-txt"
          aria-label="Close history panel"
        >
          ✕
        </button>
      </div>
    </div>

    {#if browser.historyLog.length === 0}
      <p class="px-3 py-4 text-[11px] text-nc-mut-2">
        Abhi kuch visit nahi hua. Jo page kholo ge wo yahan aayega; Ctrl + Shift + Del sab saaf
        karta hai.
      </p>
    {:else}
      <ul class="max-h-40 overflow-y-auto">
        {#each browser.historyLog as entry (entry.at + entry.url)}
          <li>
            <button
              type="button"
              onclick={() => browser.navigate(entry.url)}
              class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors hover:bg-nc-panel-2"
              title={entry.url}
            >
              <span class="w-10 shrink-0 text-[10px] tabular-nums text-nc-mut-2"
                >{when(entry.at)}</span
              >
              <span class="min-w-0 flex-1 truncate text-[11px] text-nc-txt">{entry.title}</span>
              <span class="max-w-[45%] truncate text-[10px] text-nc-mut-2">{entry.url}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
