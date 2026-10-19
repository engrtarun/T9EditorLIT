<script lang="ts">
  import { SHORTCUT_GROUPS } from '../shortcuts';
  import { layout } from '../stores/layout.svelte';
  import { project } from '../stores/project.svelte';
  import { mode } from '../stores/mode.svelte';

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      layout.helpOpen = false;
      e.stopPropagation();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- Shortcut sheet — Clipchamp's `Ctrl + /` -->
{#if layout.helpOpen}
  <div
    class="fixed inset-0 z-[400] grid place-items-center bg-black/70 p-6"
    role="dialog"
    aria-modal="true"
    aria-label="Keyboard shortcuts"
  >
    <div
      class="max-h-full w-full max-w-4xl overflow-auto rounded-2xl border border-nc-line-2 bg-nc-panel p-6 shadow-2xl"
    >
      <div class="mb-4 flex items-center gap-3">
        <span
          class="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-nc-gold to-nc-gold-dim text-[15px] font-black text-nc-bg"
          >7</span
        >
        <div>
          <h2 class="text-base font-bold">Keyboard shortcuts</h2>
          <p class="text-[11px] text-nc-mut">
            Microsoft's official Clipchamp list, mapped to the transcript editor ·
            {project.lines.length} lines loaded · {mode.current} mode
          </p>
        </div>
        <div class="flex-1"></div>
        <button
          onclick={() => (layout.helpOpen = false)}
          class="rounded-lg border border-nc-line px-3 py-1.5 text-xs text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
        >
          Close (Esc)
        </button>
      </div>

      <div class="grid gap-5 sm:grid-cols-2">
        {#each SHORTCUT_GROUPS as g (g.title)}
          <section>
            <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-gold">{g.title}</h3>
            <ul class="space-y-1">
              {#each g.rows as r (r.keys + r.action)}
                <li class="flex items-start gap-2 text-[11px]">
                  <kbd
                    class="shrink-0 rounded border border-nc-line-2 bg-nc-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-nc-txt"
                    >{r.keys}</kbd
                  >
                  <span class="min-w-0 flex-1 leading-4 text-nc-mut">
                    {r.action}
                    {#if r.note}
                      <span class="block text-[9px] text-nc-mut-2/80">↳ {r.note}</span>
                    {/if}
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    </div>
  </div>
{/if}
