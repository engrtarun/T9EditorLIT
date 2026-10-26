<script lang="ts">
  import { project } from '../../stores/project.svelte';
  import { toast } from '../../stores/toast.svelte';
  import {
    cancelExport,
    concatParts,
    defaultDbPath,
    isTauri,
    onExportProgress,
    pickOutput,
    startExport,
    stillClip
  } from '../../ipc';
  import type { ExportOptions, ExportResult } from '../../ipc';
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
  import { exportDefaults } from '../../stores/export-defaults.svelte';

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
  // "Advanced settings" in Create New Project sets this ahead of time; the
  // panel's own dropdown still overrides it for one export.
  let resolution = $state<ResolutionId>(exportDefaults.resolution);
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
  /** True once the user cancels — the part loop stops before the next clip. */
  let aborted = false;
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

  /** Extra clips on the timeline, appended after the main cut. */
  const extraClips = $derived(project.clips);

  /**
   * A project with extra clips is exported as a **sequence**: the main cut is
   * rendered first, then each extra clip (or still), and the parts are joined.
   * One clip is the ordinary single-source engine, untouched.
   */
  const multiClip = $derived(project.clips.length > 0);

  /** Progress offset/width for the part currently rendering. */
  let progressBase = 0;
  let progressSpan = 100;

  /** How much audio the export carries: the kept part, or the whole recording. */
  const audioSecs = $derived(applyCuts ? project.keptSec : project.durationSec);

  /** What the final file actually plays: the main cut, then every extra clip. */
  const finalSecs = $derived(project.keptSec + project.extrasDuration);

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
    multiClip
      ? isTauri() && !!project.sourcePath && segments.length > 0
      : format === 'gif'
        ? !gifTooLong && segments.length > 0
        : segments.length > 0 && (isTauri() ? !!project.sourcePath : browserCanExport)
  );

  /**
   * A multi-clip sequence always comes out as MP4.
   *
   * GIF and MP3 parts cannot be joined with a stream copy, and re-encoding the
   * whole sequence again just to make a GIF is not an export - it is a second
   * render. So the format locks to video for as long as extras are on the
   * timeline; removing them unlocks it again.
   */
  $effect(() => {
    if (multiClip && format !== 'video') format = 'video';
  });

  function defaultOutputName() {
    return defaultFileName(project.name, format);
  }

  /**
   * The name and folder the export starts with.
   *
   * The folder is the one chosen in Create New Project's advanced settings —
   * empty means "just the file name", which is the behaviour the app had
   * before that setting existed.
   */
  function defaultOutputPath() {
    return exportDefaults.pathFor(defaultOutputName());
  }

  // The default name follows the format until the user types their own.
  $effect(() => {
    const path = exportDefaults.pathFor(defaultFileName(project.name, format));
    if (!outputTouched) output = path;
  });

  async function chooseOutput() {
    const picked = await pickOutput(defaultOutputPath(), [
      { name: `${preset.label} file`, extensions: [preset.ext] }
    ]);
    if (picked) {
      output = picked;
      outputTouched = true;
    }
  }

  /**
   * Render the whole timeline: the main cut, then every extra clip.
   *
   * Each part goes through the normal single-source engine - the main cut is
   * exactly the export this app has always produced. An extra clip is a short
   * in/out range of its own file, and a still becomes a silent H.264 clip. All
   * parts share one frame size so the final join is a plain stream copy.
   */
  async function runSequence(
    out: string,
    options: ExportOptions,
    source: string,
    dbPath: string | null
  ): Promise<ExportResult> {
    const total = 1 + project.clips.length;
    // `source` would let every clip keep its own size, and a concat needs one
    // frame. A concrete preset (1080p by default) makes the parts match.
    const res: ResolutionId = resolution === 'source' ? '1080p' : resolution;
    const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
    // A project with its own shape (9:16, 1:1, …) renders every part onto that
    // canvas, so the joined file is the shape the preview promised.
    const canvas = project.canvasFrame;
    const frame = canvas
      ? { width: canvas[0], height: canvas[1] }
      : (targetFrame(res, project.media?.width ?? 0, project.media?.height ?? 0) ?? {
          width: even(project.media?.width || 1920),
          height: even(project.media?.height || 1080)
        });
    const partOptions: ExportOptions = {
      ...options,
      mode: 'encode',
      format: 'video',
      resolution: res,
      // The parts come from different files: one letterboxed frame, one fps,
      // one audio layout, or the final join cannot be a stream copy.
      canvas: [frame.width, frame.height]
    };
    const base = out.replace(/\.[^.]+$/, '');

    progressBase = 0;
    progressSpan = 100 / total;
    const main = await startExport({
      source,
      segments,
      output: `${base}.part0.mp4`,
      options: partOptions,
      dbPath
    });
    if (aborted) throw new Error('export cancelled');
    const parts: string[] = [main.output];

    for (let i = 0; i < project.clips.length; i++) {
      const clip = project.clips[i];
      const part = `${base}.part${i + 1}.mp4`;
      progressBase = ((i + 1) / total) * 100;
      progressSpan = 100 / total;
      message = `${clip.name} render ho raha hai…`;
      if (clip.kind === 'image') {
        await stillClip(clip.path, clip.outSec - clip.inSec, part, frame.width, frame.height);
      } else {
        await startExport({
          source: clip.path,
          // An extra clip is exported whole: its transcript does not exist, so
          // there is nothing to cut inside it.
          segments: [{ start: clip.inSec, end: clip.outSec }],
          output: part,
          options: partOptions,
          dbPath
        });
      }
      if (aborted) throw new Error('export cancelled');
      parts.push(part);
    }

    progressBase = 0;
    progressSpan = 100;
    stage = 'concat';
    message = `${parts.length} clips jode ja rahe hain…`;
    return concatParts(parts, out);
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
    if (multiClip && !isTauri()) {
      toast.push('info', 'Multi-clip export desktop app me chalta hai');
      return;
    }

    running = true;
    aborted = false;
    percent = 0;
    result = null;
    warnings = [];
    toast.push('info', multiClip ? 'Sequence export shuru…' : 'Export shuru…');

    const unlisten = await onExportProgress((p) => {
      percent = Math.min(99, progressBase + (p.percent / 100) * progressSpan);
      stage = p.stage;
      message = p.message;
    });

    try {
      const dbPath = await defaultDbPath().catch(() => null);
      const out = output || defaultOutputPath();
      output = out;

      const options: ExportOptions = {
        mode: engine,
        alignToleranceMs: 40,
        quality,
        format,
        resolution,
        // A non-16:9 project is letterboxed onto its own canvas; 16:9 stays
        // "keep the source", which is what makes a lossless copy possible.
        canvas: format === 'video' ? project.canvasFrame : null,
        bitrateKbps: bitrate,
        sampleRate,
        channels,
        normalize,
        applyCuts,
        title: project.name
      };

      progressBase = 0;
      progressSpan = 100;
      const res = multiClip
        ? await runSequence(out, options, source ?? '', dbPath)
        : await startExport({
            source: source ?? project.media?.url ?? '',
            segments,
            output: out,
            options,
            dbPath
          });
      if (aborted) return;
      result = res;
      warnings = res.warnings ?? [];
      percent = 100;
      toast.push('info', `Export done · ${fmtSize(res.sizeBytes)}`);
    } catch (e) {
      if (aborted) toast.push('info', 'Export cancelled');
      else toast.push('warn', `Export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      unlisten();
      running = false;
    }
  }

  function cancel() {
    aborted = true;
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
    {#if multiClip}
      <span
        class="rounded bg-nc-brand/15 px-1.5 py-0.5 font-mono text-[10px] text-nc-brand"
        title="Extra clips on the timeline are appended after the main cut"
      >
        + {extraClips.length} clip{extraClips.length === 1 ? '' : 's'}
      </span>
    {/if}
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
          <p class="mt-1 font-mono text-xl text-nc-brand">{fmtHuman(finalSecs)}</p>
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
            {@const locked = multiClip && f.id !== 'video'}
            <button
              onclick={() => (format = f.id)}
              disabled={locked}
              title={locked ? 'Multi-clip sequence ek hi MP4 me join hota hai' : f.note}
              class="rounded-lg border px-3 py-2.5 text-left transition-colors
                     {locked
                ? 'cursor-not-allowed border-nc-line bg-nc-panel opacity-40'
                : format === f.id
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
        {#if multiClip}
          <p class="mt-2 text-[11px] leading-relaxed text-nc-mut">
            Timeline pe <b class="text-nc-brand">{extraClips.length}</b> extra clip
            {extraClips.length === 1 ? 'hai' : 'hain'} — poora sequence ek MP4 me jayega. Main cut pehle,
            phir har clip; aakhir me ek stream-copy join.
          </p>
        {/if}
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
          {#if multiClip && resolution === 'source'}
            <p class="mt-2 text-[10px] text-nc-brand">
              Multi-clip join ke liye source ki jagah 1080p use hoga — sab parts ka frame same rehna
              zaroori hai.
            </p>
          {/if}
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
            placeholder={defaultOutputPath()}
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
