<!--
  uBlock Origin Lite — real per-site control panel.

  The shield button (BrowserView top bar) opens this sheet. Unlike a fake
  status card it drives the **real** uBOL behaviour through the T9 content
  bridge: every action goes to uBOL's own service worker via the injected
  content script, so the filtering mode, the zapper and the pickers are the
  ones uBOL would use itself in a normal browser.

  It is a layout sheet like the settings menu — the page webview is parked
  while it is open (see the overlay effect in BrowserView).
-->
<script lang="ts">
  import { browser } from '../../stores/browser.svelte';
  import { ublock } from '../../stores/ublock.svelte';

  let levels = ['No filtering', 'Basic', 'Optimal', 'Complete'];

  const tools: Array<'zapper' | 'picker' | 'unpicker'> = ['zapper', 'picker', 'unpicker'];

  const toolLabel = (k: 'zapper' | 'picker' | 'unpicker') =>
    k === 'zapper'
      ? 'Block element (zapper)'
      : k === 'picker'
        ? 'Pick element to block'
        : 'Unpick an element';

  const runTool = (k: 'zapper' | 'picker' | 'unpicker') => () => void ublock.runTool(k);
</script>

<svelte:window
  onkeydowncapture={(e) => {
    if (e.key === 'Escape' && ublock.panelOpen) {
      e.preventDefault();
      e.stopPropagation();
      ublock.closePanel();
    }
  }}
/>

{#if ublock.panelOpen}
  <div
    class="shrink-0 border-b border-nc-line bg-nc-panel shadow-[0_8px_24px_rgba(0,0,0,0.25)]"
    aria-label="Ad blocker panel"
  >
    <div class="flex h-9 items-center justify-between gap-2 border-b border-nc-line/60 px-3">
      <span class="text-[11px] font-semibold tracking-wide text-nc-mut uppercase">Ad blocker</span>
      <span class="text-[11px] text-nc-mut uppercase">{browser.active ? 'page-wide' : ''}</span>
    </div>

    <div class="flex flex-col gap-3 px-3 py-3">
      {#if !browser.active}
        <p class="text-[12px] text-nc-mut">Koi tab active nahi — panel tab par chal raha hai.</p>
      {:else if ublock.error}
        <p class="text-[12px] text-red-400">{ublock.error}</p>
      {:else if ublock.busy}
        <p class="text-[12px] text-nc-mut">uBlock action chal raha hai…</p>
      {:else if ublock.panel}
        <div class="flex flex-col gap-1.5">
          <span class="text-[11px] text-nc-mut">Site</span>
          <span class="break-all text-[12px] font-medium text-nc-txt">{ublock.site}</span>
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-[11px] text-nc-mut">Filtering mode</span>
          <input
            type="range"
            min="0"
            max="3"
            step="1"
            value={ublock.level}
            oninput={(e) => void ublock.setLevel(Number((e.target as HTMLInputElement).value))}
            style="accent-color: var(--color-nc-brand)"
            aria-label="Filtering mode"
          />
          <div class="flex justify-between text-[10px] text-nc-mut">
            {#each levels as lv, i (i)}
              <span>{lv}</span>
            {/each}
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          {#each tools as k (k)}
            <button
              type="button"
              onclick={runTool(k)}
              disabled={ublock.busy}
              class="rounded-full border border-nc-line bg-nc-panel-2 px-3 py-1.5 text-[11px] font-medium text-nc-txt transition-colors hover:border-nc-brand hover:text-nc-brand disabled:opacity-40"
            >
              {toolLabel(k)}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
