<script lang="ts">
  import { SHORTCUT_GROUPS } from '../shortcuts';
  import { layout } from '../stores/layout.svelte';
  import { project } from '../stores/project.svelte';
  import { mode } from '../stores/mode.svelte';
  import { keys, KEY_LABELS, type KeyAction } from '../stores/keys.svelte';

  let tab = $state<'list' | 'custom'>('list');
  let capturing = $state<KeyAction | null>(null);

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (capturing) {
        capturing = null;
        return;
      }
      layout.helpOpen = false;
      e.stopPropagation();
      return;
    }
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');
    parts.push(e.key.toLowerCase());
    keys.set(capturing, parts.join('+'));
    capturing = null;
  }

  const ACTIONS = Object.keys(KEY_LABELS) as KeyAction[];
</script>

<svelte:window onkeydown={onKey} />

<!-- Shortcut sheet — Clipchamp's `Ctrl + /`, plus a rebind editor -->
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
          class="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-nc-gold to-nc-gold-dim text-[12px] font-black text-nc-bg"
          >7</span
        >
        <div>
          <h2 class="text-base font-bold">Keyboard shortcuts</h2>
          <p class="text-[11px] text-nc-mut">
            Microsoft's official Clipchamp list · {project.lines.length} lines · {mode.current} mode
          </p>
        </div>
        <div class="flex-1"></div>

        <div class="flex gap-1 rounded-lg bg-nc-panel-2 p-0.5">
          <button
            onclick={() => (tab = 'list')}
            class="rounded-md px-3 py-1 text-[11px] font-medium transition-colors
                   {tab === 'list' ? 'bg-nc-gold text-nc-bg' : 'text-nc-mut hover:text-nc-txt'}"
          >
            All keys
          </button>
          <button
            onclick={() => (tab = 'custom')}
            class="rounded-md px-3 py-1 text-[11px] font-medium transition-colors
                   {tab === 'custom' ? 'bg-nc-gold text-nc-bg' : 'text-nc-mut hover:text-nc-txt'}"
          >
            Customize
          </button>
        </div>

        <button
          onclick={() => (layout.helpOpen = false)}
          class="rounded-lg border border-nc-line px-3 py-1.5 text-xs text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
        >
          Close (Esc)
        </button>
      </div>

      {#if tab === 'list'}
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
      {:else}
        <p class="mb-3 text-[11px] leading-relaxed text-nc-mut">
          Koi bhi key dabao — naya binding turant apply hota hai aur is machine pe yaad rehta hai. <span
            class="text-nc-mut-2">(Rebind karte waqt is window ko hi focus rakho.)</span
          >
        </p>
        <div class="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {#each ACTIONS as a (a)}
            <div class="flex items-center gap-2 border-b border-nc-line/40 py-1">
              <span class="min-w-0 flex-1 truncate text-[11px] text-nc-mut">{KEY_LABELS[a]}</span>
              <button
                onclick={() => (capturing = a)}
                class="shrink-0 rounded border px-2 py-0.5 font-mono text-[10px] transition-colors
                       {capturing === a
                  ? 'border-nc-gold bg-nc-gold/15 text-nc-gold'
                  : 'border-nc-line-2 bg-nc-panel-2 text-nc-txt hover:border-nc-gold/50'}"
              >
                {capturing === a ? 'press a key…' : keys.label(a)}
              </button>
            </div>
          {/each}
        </div>
        <div class="mt-4 flex justify-end">
          <button
            onclick={() => keys.reset()}
            class="rounded-lg border border-nc-line px-3 py-1.5 text-[11px] text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
          >
            Reset to defaults
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
