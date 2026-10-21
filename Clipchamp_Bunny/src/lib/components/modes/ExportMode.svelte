<script lang="ts">
  import { project } from '../../stores/project.svelte';
  import { toast } from '../../stores/toast.svelte';
  import {
    cancelExport,
    defaultDbPath,
    isTauri,
    onExportProgress,
    pickOutput,
    startExport
  } from '../../ipc';
  import { fmtHuman, fmtSize } from '../../utils';

  /**
   * MODE 3 — EXPORT.
   *
   * Runs the real Rust export engine: FFmpeg pieces that stream-copy where the
   * cut lands on a keyframe and re-encode only where it does not, then a
   * disk-bound remux to join them. Progress streams over the `export-progress`
   * event.
   */
  type Engine = 'hybrid' | 'copy' | 'encode';
  const ENGINES: Array<{ id: Engine; label: string; note: string }> = [
    {
      id: 'hybrid',
      label: 'Hybrid (recommended)',
      note: 'stream-copy where the cut is on a keyframe, re-encode only where it is not'
    },
    {
      id: 'copy',
      label: 'Lossless copy',
      note: '-c copy · snaps cuts to the nearest keyframe · never re-encodes'
    },
    {
      id: 'encode',
      label: 'Exact cuts',
      note: 're-encodes everything · frame-accurate but slow'
    }
  ];
  const QUALITIES = ['original', 'high', 'balanced', 'small'] as const;

  let engine = $state<Engine>('hybrid');
  let quality = $state<(typeof QUALITIES)[number]>('high');
  let output = $state('');
  let running = $state(false);
  let percent = $state(0);
  let stage = $state('');
  let message = $state('');
  let result = $state<{
    output: string;
    sizeBytes: number;
    durationSecs: number;
    pieceCount: number;
  } | null>(null);
  let warnings = $state<string[]>([]);

  /** The cut list, in final-video order — this is exactly what gets rendered. */
  const segments = $derived(
    project.orderedSegments.map((s) => ({ start: s.startSec, end: s.endSec }))
  );

  const estimated = $derived(
    project.media && project.media.sizeBytes > 0
      ? (project.media.sizeBytes * project.keptSec) / Math.max(project.durationSec, 1)
      : 0
  );

  function defaultOutputName() {
    const base = (project.name || 't9-editor-lit').replace(/[^\w\- ]+/g, '');
    return `${base} (cut).mp4`;
  }

  async function chooseOutput() {
    const picked = await pickOutput(defaultOutputName());
    if (picked) output = picked;
  }

  async function run() {
    if (running) return;
    const source = project.sourcePath;
    if (!source) {
      toast.push('warn', 'Pehle video load karo (Media mode)');
      return;
    }
    if (!segments.length) {
      toast.push('warn', 'Kuch bacha hi nahi — sab cut hai');
      return;
    }

    running = true;
    percent = 0;
    result = null;
    warnings = [];
    toast.push('info', 'Export shuru…');

    const unlisten = await onExportProgress((p) => {
      percent = p.percent;
      stage = p.stage;
      message = p.message;
    });

    try {
      const dbPath = await defaultDbPath().catch(() => null);
      const out = output || (await pickOutput(defaultOutputName())) || defaultOutputName();
      output = out;

      const res = await startExport({
        source,
        segments,
        output: out,
        options: { mode: engine, alignToleranceMs: 40, quality },
        dbPath
      });
      result = res;
      warnings = res.warnings ?? [];
      percent = 100;
      toast.push('info', `Export done · ${fmtSize(res.sizeBytes)}`);
    } catch (e) {
      toast.push('warn', `Export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      unlisten();
      running = false;
    }
  }

  function cancel() {
    void cancelExport();
    running = false;
    toast.push('info', 'Export cancelled');
  }
</script>

<div class="flex min-w-0 flex-1 flex-col">
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-nc-line bg-nc-panel px-3">
    <h2 class="text-[13px] font-semibold">Export</h2>
    <span class="rounded bg-nc-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-nc-mut">
      {segments.length} segment{segments.length === 1 ? '' : 's'}
    </span>
    <div class="flex-1"></div>
    {#if !isTauri()}
      <span class="text-[10px] text-nc-mut-2">Desktop app me chalta hai</span>
    {/if}
  </div>

  <div class="nc-scroll min-h-0 flex-1 p-6">
    <div class="mx-auto max-w-3xl space-y-5">
      <!-- summary -->
      <div class="grid grid-cols-3 gap-3">
        <div class="rounded-xl border border-nc-line bg-nc-panel p-4">
          <p class="text-[10px] tracking-widest text-nc-mut">RAW</p>
          <p class="mt-1 font-mono text-xl text-nc-mut-2">{fmtHuman(project.durationSec)}</p>
        </div>
        <div class="rounded-xl border border-nc-brand/40 bg-nc-brand/5 p-4">
          <p class="text-[10px] tracking-widest text-nc-brand">FINAL</p>
          <p class="mt-1 font-mono text-xl text-nc-brand">{fmtHuman(project.keptSec)}</p>
        </div>
        <div class="rounded-xl border border-nc-red/40 bg-nc-red/5 p-4">
          <p class="text-[10px] tracking-widest text-nc-red">KACHRA CUT 🔥</p>
          <p class="mt-1 font-mono text-xl text-nc-red">{fmtHuman(project.cutSec)}</p>
        </div>
      </div>

      <!-- engine -->
      <section>
        <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-mut">EXPORT ENGINE</h3>
        <div class="grid gap-2">
          {#each ENGINES as e (e.id)}
            <button
              onclick={() => (engine = e.id)}
              class="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors
                     {engine === e.id
                ? 'border-nc-brand bg-nc-brand/5'
                : 'border-nc-line bg-nc-panel hover:border-nc-line-2'}"
            >
              <span
                class="grid h-4 w-4 shrink-0 place-items-center rounded-full border
                       {engine === e.id ? 'border-nc-brand' : 'border-nc-line-2'}"
              >
                {#if engine === e.id}<span class="h-2 w-2 rounded-full bg-nc-brand"></span>{/if}
              </span>
              <span class="min-w-0">
                <span class="block text-xs font-semibold">{e.label}</span>
                <span class="block text-[10px] text-nc-mut">{e.note}</span>
              </span>
            </button>
          {/each}
        </div>

        <div class="mt-3 flex items-center gap-3">
          <span class="text-[11px] text-nc-mut">Quality</span>
          <div class="flex gap-1">
            {#each QUALITIES as q (q)}
              <button
                onclick={() => (quality = q)}
                class="rounded-md px-2.5 py-1 text-[11px] capitalize transition-colors
                       {quality === q
                  ? 'bg-nc-brand text-nc-bg'
                  : 'bg-nc-panel-2 text-nc-mut hover:text-nc-txt'}"
              >
                {q}
              </button>
            {/each}
          </div>
          {#if estimated > 0}
            <span class="ml-auto font-mono text-[10px] text-nc-mut-2">≈ {fmtSize(estimated)}</span>
          {/if}
        </div>
      </section>

      <!-- output -->
      <section>
        <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-mut">OUTPUT</h3>
        <div class="flex gap-2">
          <input
            bind:value={output}
            placeholder={defaultOutputName()}
            class="min-w-0 flex-1 rounded-lg border border-nc-line bg-nc-panel px-3 py-2 font-mono text-[11px] outline-none focus:border-nc-brand/50"
          />
          <button
            onclick={chooseOutput}
            class="rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2 text-[11px] hover:border-nc-brand/50"
          >
            Choose…
          </button>
        </div>
      </section>

      <!-- action -->
      {#if running}
        <div class="space-y-2 rounded-xl border border-nc-brand/40 bg-nc-brand/5 p-4">
          <div class="flex items-center gap-2 text-[11px]">
            <span class="text-nc-brand">{stage.toUpperCase() || 'WORKING'}</span>
            <span class="min-w-0 flex-1 truncate text-nc-mut">{message}</span>
            <span class="font-mono text-nc-txt">{percent.toFixed(0)}%</span>
          </div>
          <div class="h-2 overflow-hidden rounded-full bg-nc-panel-2">
            <div
              class="h-full rounded-full bg-gradient-to-r from-nc-brand to-nc-green transition-[width] duration-200"
              style="width:{percent}%"
            ></div>
          </div>
          <button
            onclick={cancel}
            class="w-full rounded-lg border border-nc-line py-1.5 text-[11px] text-nc-mut hover:text-nc-txt"
          >
            Cancel
          </button>
        </div>
      {:else}
        <button
          onclick={run}
          disabled={!segments.length || !project.sourcePath}
          class="w-full rounded-xl bg-nc-brand py-3.5 text-sm font-bold text-nc-bg transition hover:brightness-110 disabled:opacity-40"
        >
          ▶ EXPORT FINAL VIDEO
        </button>
      {/if}

      {#if result}
        <div class="nc-tie-edge rounded-xl border border-nc-brand/40 bg-nc-brand/5 p-5 text-center">
          <p class="text-base font-bold text-nc-brand">Kaam khatam. Ab aaram karo.</p>
          <p class="mt-1 text-xs text-nc-mut">
            {result.pieceCount} piece{result.pieceCount === 1 ? '' : 's'} · {fmtSize(
              result.sizeBytes
            )} ·
            {fmtHuman(result.durationSecs)}
          </p>
          <p class="mt-2 break-all font-mono text-[10px] text-nc-mut-2">{result.output}</p>
          {#if warnings.length}
            <ul class="mt-3 space-y-1 text-left text-[10px] text-nc-red">
              {#each warnings as w (w)}<li>· {w}</li>{/each}
            </ul>
          {/if}
          <p class="mt-3 text-[10px] text-nc-mut-2">
            7:3 ratio. Ek strike me kaam khatam. — T9 Editor LIT
          </p>
        </div>
      {/if}
    </div>
  </div>
</div>
