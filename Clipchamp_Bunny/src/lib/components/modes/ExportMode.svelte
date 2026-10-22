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
  import {
    BITRATES,
    FORMATS,
    GIF_FPS,
    GIF_MAX_SECS,
    GIF_WIDTH,
    RESOLUTIONS,
    SAMPLE_RATES,
    defaultFileName,
    estimateGifBytes,
    estimateMp3Bytes,
    formatPreset,
    targetFrame
  } from '../../export-presets';
  import type { ExportFormat, ResolutionId } from '../../export-presets';

  /**
   * MODE 3 — EXPORT.
   *
   * Runs the real Rust export engine: FFmpeg pieces that stream-copy where the
   * cut lands on a keyframe and re-encode only where it does not, then a
   * disk-bound remux to join them. Progress streams over the `export-progress`
   * event.
   *
   * Three formats come out of the same panel — a **video** (at the source
   * resolution or downscaled to 480p/720p/1080p/4K), a **GIF** (a short
   * looping clip) and an **MP3** (the audio only — music, a voiceover, the
   * dialogue of the video, with no picture at all).
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

  let format = $state<ExportFormat>('video');
  let resolution = $state<ResolutionId>('source');
  let engine = $state<Engine>('hybrid');
  let quality = $state<(typeof QUALITIES)[number]>('high');
  let bitrate = $state<number>(192);
  let sampleRate = $state<number>(44100);
  let channels = $state<number>(2);
  let normalize = $state(false);
  let applyCuts = $state(true);
  let output = $state('');
  /** True once the user types a name of their own — the default stops following. */
  let outputTouched = $state(false);
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

  /** How much audio the export carries: the kept part, or the whole recording. */
  const audioSecs = $derived(applyCuts ? project.keptSec : project.durationSec);

  /** The frame a rescaled video would land on — `null` when nothing changes. */
  const frame = $derived(
    targetFrame(resolution, project.media?.width ?? 0, project.media?.height ?? 0)
  );

  /** The preset of the chosen format — the extension and the one-liner. */
  const preset = $derived(formatPreset(format));

  /** A GIF is for short clips; Clipchamp's own rule is 15 seconds. */
  const gifTooLong = $derived(project.keptSec > GIF_MAX_SECS);

  const estimated = $derived.by(() => {
    if (format === 'mp3') return estimateMp3Bytes(audioSecs, bitrate);
    if (format === 'gif') {
      return estimateGifBytes(audioSecs, GIF_FPS, GIF_WIDTH, project.media?.height ?? 270);
    }
    if (!project.media || project.media.sizeBytes <= 0) return 0;
    return (project.media.sizeBytes * project.keptSec) / Math.max(project.durationSec, 1);
  });

  /** The browser preview has no Rust engine — only the MP3 path runs there. */
  const browserCanExport = $derived(format === 'mp3');

  const canRun = $derived(
    format === 'gif'
      ? !gifTooLong && segments.length > 0
      : segments.length > 0 && (isTauri() ? !!project.sourcePath : browserCanExport)
  );

  function defaultOutputName() {
    return defaultFileName(project.name, format);
  }

  // The default name follows the format until the user types their own.
  $effect(() => {
    const name = defaultFileName(project.name, format);
    if (!outputTouched) output = name;
  });

  async function chooseOutput() {
    const picked = await pickOutput(defaultOutputName(), [
      { name: `${preset.label} file`, extensions: [preset.ext] }
    ]);
    if (picked) {
      output = picked;
      outputTouched = true;
    }
  }

  async function run() {
    if (running) return;
    const source = project.sourcePath;
    if (!source && !isTauri()) {
      // Browser preview: the dev server renders the MP3 from the baked asset.
      if (!project.media?.url) {
        toast.push('warn', 'Pehle media load karo');
        return;
      }
    } else if (!source) {
      toast.push('warn', 'Pehle video load karo (Media mode)');
      return;
    }
    if (!segments.length) {
      toast.push('warn', 'Kuch bacha hi nahi — sab cut hai');
      return;
    }
    if (format === 'gif' && gifTooLong) {
      toast.push('warn', `GIF sirf ${GIF_MAX_SECS} second tak ka hota hai`);
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
      const out = output || defaultOutputName();
      output = out;

      const res = await startExport({
        source: source ?? project.media?.url ?? '',
        segments,
        output: out,
        options: {
          mode: engine,
          alignToleranceMs: 40,
          quality,
          format,
          resolution,
          bitrateKbps: bitrate,
          sampleRate,
          channels,
          normalize,
          applyCuts,
          title: project.name
        },
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
      <span class="text-[10px] text-nc-mut-2">
        {browserCanExport ? 'Dev server FFmpeg se render hota hai' : 'Desktop app me chalta hai'}
      </span>
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

      <!-- format -->
      <section>
        <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-mut">FORMAT</h3>
        <div class="grid gap-2 sm:grid-cols-3">
          {#each FORMATS as f (f.id)}
            <button
              onclick={() => (format = f.id)}
              class="rounded-lg border px-3 py-2.5 text-left transition-colors
                     {format === f.id
                ? 'border-nc-brand bg-nc-brand/5'
                : 'border-nc-line bg-nc-panel hover:border-nc-line-2'}"
            >
              <span class="flex items-center gap-2">
                <span
                  class="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border
                         {format === f.id ? 'border-nc-brand' : 'border-nc-line-2'}"
                >
                  {#if format === f.id}<span class="h-1.5 w-1.5 rounded-full bg-nc-brand"
                    ></span>{/if}
                </span>
                <span class="text-xs font-semibold">{f.label}</span>
                <span class="ml-auto font-mono text-[10px] uppercase text-nc-mut-2">.{f.ext}</span>
              </span>
              <span class="mt-1 block pl-5.5 text-[10px] text-nc-mut">{f.note}</span>
            </button>
          {/each}
        </div>
      </section>

      <!-- resolution (video only) -->
      {#if format === 'video'}
        <section>
          <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-mut">VIDEO QUALITY</h3>
          <div class="grid gap-2 sm:grid-cols-2">
            {#each RESOLUTIONS as r (r.id)}
              <button
                onclick={() => (resolution = r.id)}
                class="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors
                       {resolution === r.id
                  ? 'border-nc-brand bg-nc-brand/5'
                  : 'border-nc-line bg-nc-panel hover:border-nc-line-2'}"
              >
                <span
                  class="grid h-4 w-4 shrink-0 place-items-center rounded-full border
                         {resolution === r.id ? 'border-nc-brand' : 'border-nc-line-2'}"
                >
                  {#if resolution === r.id}<span class="h-2 w-2 rounded-full bg-nc-brand"
                    ></span>{/if}
                </span>
                <span class="min-w-0">
                  <span class="block text-xs font-semibold">{r.label}</span>
                  <span class="block text-[10px] text-nc-mut">{r.note}</span>
                </span>
              </button>
            {/each}
          </div>
          {#if frame}
            <p class="mt-2 font-mono text-[10px] text-nc-mut-2">
              {project.media?.width}×{project.media?.height} → {frame.width}×{frame.height} · poori video
              re-encode hogi
            </p>
          {:else if resolution !== 'source'}
            <p class="mt-2 text-[10px] text-nc-mut-2">
              Source {project.media?.width}×{project.media?.height} hai — isse chhota nahi banega.
            </p>
          {/if}
        </section>
      {/if}

      <!-- engine (video only) -->
      {#if format === 'video'}
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
              <span class="ml-auto font-mono text-[10px] text-nc-mut-2">≈ {fmtSize(estimated)}</span
              >
            {/if}
          </div>
        </section>
      {/if}

      <!-- gif options -->
      {#if format === 'gif'}
        <section>
          <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-mut">GIF</h3>
          <div class="rounded-lg border border-nc-line bg-nc-panel p-3">
            <p class="text-[11px] text-nc-mut">
              {GIF_FPS} fps · {GIF_WIDTH} px wide · looping · palette-optimised
            </p>
            <p class="mt-1 text-[10px] text-nc-mut-2">
              GIF sirf {GIF_MAX_SECS} second tak ke clip ke liye hai.
            </p>
            {#if gifTooLong}
              <p class="mt-2 text-[10px] text-nc-red">
                · Ye cut {fmtHuman(project.keptSec)} ka hai — GIF nahi ban sakta. Video ya MP3 chuna lo.
              </p>
            {/if}
          </div>
          <div class="mt-3 flex items-center gap-3">
            <span class="text-[11px] text-nc-mut">Cuts</span>
            <label class="flex items-center gap-1.5 text-[11px] text-nc-txt">
              <input type="checkbox" bind:checked={applyCuts} class="accent-nc-brand" />
              {applyCuts ? 'Timeline ke cuts lagane hain' : 'Poori recording'}
            </label>
            {#if estimated > 0}
              <span class="ml-auto font-mono text-[10px] text-nc-mut-2">≈ {fmtSize(estimated)}</span
              >
            {/if}
          </div>
        </section>
      {/if}

      <!-- mp3 options -->
      {#if format === 'mp3'}
        <section>
          <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-mut">AUDIO ONLY · MP3</h3>
          <div class="rounded-lg border border-nc-line bg-nc-panel p-3">
            <p class="text-[11px] text-nc-mut">
              Music, AI voiceover, recording ya video ka dialogue — ek MP3, bilkul nahi picture.
            </p>
          </div>

          <div class="mt-3 flex items-center gap-3">
            <span class="text-[11px] text-nc-mut">Bitrate</span>
            <div class="flex gap-1">
              {#each BITRATES as b (b)}
                <button
                  onclick={() => (bitrate = b)}
                  class="rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors
                         {bitrate === b
                    ? 'bg-nc-brand text-nc-bg'
                    : 'bg-nc-panel-2 text-nc-mut hover:text-nc-txt'}"
                >
                  {b}k
                </button>
              {/each}
            </div>
            {#if estimated > 0}
              <span class="ml-auto font-mono text-[10px] text-nc-mut-2">≈ {fmtSize(estimated)}</span
              >
            {/if}
          </div>

          <div class="mt-3 flex items-center gap-3">
            <span class="text-[11px] text-nc-mut">Sample rate</span>
            <div class="flex gap-1">
              {#each SAMPLE_RATES as sr (sr)}
                <button
                  onclick={() => (sampleRate = sr)}
                  class="rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors
                         {sampleRate === sr
                    ? 'bg-nc-brand text-nc-bg'
                    : 'bg-nc-panel-2 text-nc-mut hover:text-nc-txt'}"
                >
                  {sr === 44100 ? '44.1 kHz' : '48 kHz'}
                </button>
              {/each}
            </div>
            <span class="text-[11px] text-nc-mut">Channels</span>
            <div class="flex gap-1">
              <button
                onclick={() => (channels = 2)}
                class="rounded-md px-2.5 py-1 text-[11px] transition-colors
                       {channels === 2
                  ? 'bg-nc-brand text-nc-bg'
                  : 'bg-nc-panel-2 text-nc-mut hover:text-nc-txt'}"
              >
                Stereo
              </button>
              <button
                onclick={() => (channels = 1)}
                class="rounded-md px-2.5 py-1 text-[11px] transition-colors
                       {channels === 1
                  ? 'bg-nc-brand text-nc-bg'
                  : 'bg-nc-panel-2 text-nc-mut hover:text-nc-txt'}"
              >
                Mono
              </button>
            </div>
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-4">
            <label class="flex items-center gap-1.5 text-[11px] text-nc-txt">
              <input type="checkbox" bind:checked={applyCuts} class="accent-nc-brand" />
              {applyCuts ? 'Timeline ke cuts lagane hain' : 'Poori recording'}
            </label>
            <label class="flex items-center gap-1.5 text-[11px] text-nc-txt">
              <input type="checkbox" bind:checked={normalize} class="accent-nc-brand" />
              Loudness even karo (voiceover)
            </label>
            <span class="ml-auto font-mono text-[10px] text-nc-mut-2">
              {fmtHuman(audioSecs)} audio
            </span>
          </div>
        </section>
      {/if}

      <!-- output -->
      <section>
        <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-mut">OUTPUT</h3>
        <div class="flex gap-2">
          <input
            value={output}
            oninput={(e) => {
              outputTouched = true;
              output = e.currentTarget.value;
            }}
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
          disabled={!canRun}
          class="w-full rounded-xl bg-nc-brand py-3.5 text-sm font-bold text-nc-bg transition hover:brightness-110 disabled:opacity-40"
        >
          {#if format === 'mp3'}
            ▶ EXPORT MP3 (AUDIO ONLY)
          {:else if format === 'gif'}
            ▶ EXPORT GIF
          {:else}
            ▶ EXPORT FINAL VIDEO
          {/if}
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
