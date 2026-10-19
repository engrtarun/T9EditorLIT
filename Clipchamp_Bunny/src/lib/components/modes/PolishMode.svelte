<script lang="ts">
  import { mode } from '../../stores/mode.svelte';
  import { project } from '../../stores/project.svelte';
  import type { TextClip } from '../../types';

  const PRESETS: Array<{ kind: TextClip['kind']; label: string; hint: string }> = [
    { kind: 'title', label: 'Title', hint: 'Bada heading — Apna College intro' },
    { kind: 'heading', label: 'Heading', hint: 'Section break' },
    { kind: 'code-zoom', label: 'Code Zoom', hint: 'Code par zoom-in' }
  ];

  const KIND_CHIP: Record<TextClip['kind'], string> = {
    title: 'border-nc-gold/50 bg-nc-gold/10 text-nc-gold',
    heading: 'border-nc-line-2 bg-nc-panel-2 text-nc-txt',
    'code-zoom': 'border-nc-green/40 bg-nc-green/10 text-nc-green'
  };

  let zoomStrength = $state(1.35);
  let musicVolume = $state(0.18);

  function add(kind: TextClip['kind']) {
    const text =
      kind === 'title' ? 'Naya Title' : kind === 'heading' ? 'Section Heading' : 'npm install vite';
    project.texts = [
      ...project.texts,
      {
        id: crypto.randomUUID(),
        startSec: project.cursor ? project.lines[project.cursor].startSec : 0,
        endSec: (project.cursor ? project.lines[project.cursor].endSec : 0) + 6,
        text,
        kind
      }
    ];
  }

  function remove(id: string) {
    project.texts = project.texts.filter((t) => t.id !== id);
  }

  function nudge(t: TextClip, d: number) {
    project.texts = project.texts.map((x) =>
      x.id === t.id ? { ...x, startSec: Math.max(0, x.startSec + d) } : x
    );
  }
</script>

<!-- MODE 3 — transcript component tree already destroyed by the parent #key -->
<div class="flex min-w-0 flex-1">
  <aside class="flex w-[300px] shrink-0 flex-col border-r border-nc-line bg-nc-panel">
    <h2
      class="flex h-11 items-center border-b border-nc-line px-3 text-xs font-bold tracking-wider"
    >
      TUTORIAL POLISH
    </h2>
    <div class="nc-scroll min-h-0 flex-1 p-3">
      <p class="mb-2 text-[10px] tracking-widest text-nc-mut">ADD OVERLAY</p>
      <div class="space-y-2">
        {#each PRESETS as p (p.kind)}
          <button
            onclick={() => add(p.kind)}
            class="w-full rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2 text-left hover:border-nc-gold/50"
          >
            <span class="block text-xs font-semibold">{p.label}</span>
            <span class="block text-[10px] text-nc-mut">{p.hint}</span>
          </button>
        {/each}
      </div>

      <p class="mt-5 mb-2 text-[10px] tracking-widest text-nc-mut">BACKGROUND MUSIC</p>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        bind:value={musicVolume}
        class="w-full accent-nc-gold"
      />
      <p class="mt-1 font-mono text-[10px] text-nc-mut">
        voice ke neeche: {Math.round(musicVolume * 100)}%
      </p>

      <p class="mt-5 mb-2 text-[10px] tracking-widest text-nc-mut">ZOOM STRENGTH</p>
      <input
        type="range"
        min="1"
        max="2"
        step="0.05"
        bind:value={zoomStrength}
        class="w-full accent-nc-gold"
      />
      <p class="mt-1 font-mono text-[10px] text-nc-mut">
        {zoomStrength.toFixed(2)}× (60 FPS ke liye safe)
      </p>
    </div>
  </aside>

  <div class="flex min-w-0 flex-1 flex-col">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-nc-line px-3">
      <h3 class="text-xs font-semibold">Overlays</h3>
      <span class="rounded bg-nc-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-nc-mut"
        >{project.texts.length}</span
      >
      <div class="flex-1"></div>
      <button
        onclick={() => mode.set('cut')}
        class="rounded-lg border border-nc-line px-3 py-1 text-xs text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
      >
        ← Cut mode
      </button>
      <button
        onclick={() => mode.set('export')}
        class="rounded-lg bg-nc-gold px-3 py-1 text-xs font-bold text-nc-bg hover:brightness-110"
      >
        Export →
      </button>
    </div>

    <div class="nc-scroll min-h-0 flex-1 p-4">
      {#if project.texts.length === 0}
        <div class="grid h-full place-items-center text-center">
          <p class="text-xs text-nc-mut">Koi overlay nahi. Left panel se add karo.</p>
        </div>
      {:else}
        <div class="space-y-2">
          {#each project.texts as t (t.id)}
            <div
              class="flex items-center gap-3 rounded-lg border border-nc-line bg-nc-panel px-3 py-2"
            >
              <span
                class="rounded border px-1.5 py-0.5 text-[9px] font-bold tracking-wider {KIND_CHIP[
                  t.kind
                ]}"
              >
                {t.kind}
              </span>
              <input
                bind:value={t.text}
                class="min-w-0 flex-1 bg-transparent text-xs outline-none focus:text-nc-gold"
              />
              <span class="font-mono text-[10px] text-nc-mut">{t.startSec.toFixed(0)}s</span>
              <button
                onclick={() => nudge(t, -1)}
                class="rounded px-1.5 text-xs text-nc-mut hover:bg-nc-panel-2"
                title="1s earlier"
              >
                ←
              </button>
              <button
                onclick={() => nudge(t, 1)}
                class="rounded px-1.5 text-xs text-nc-mut hover:bg-nc-panel-2"
                title="1s later"
              >
                →
              </button>
              <button
                onclick={() => remove(t.id)}
                class="rounded px-1.5 text-xs text-nc-red hover:bg-nc-red/10"
                title="Remove"
              >
                ✕
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
