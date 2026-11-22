<script lang="ts">
  import { onMount } from 'svelte';
  import { project } from '../../stores/project.svelte';
  import { toast } from '../../stores/toast.svelte';
  import {
    appNotify,
    cancelExport,
    concatParts,
    defaultDbPath,
    isTauri,
    onExportProgress,
    openPath,
    pickOutput,
    startExport,
    stillClip
  } from '../../ipc';
  import type { ExportOptions, ExportResult } from '../../ipc';
  import { exportCapabilities, preflightExport, readExportLog, revealPath } from '../../ipc';
  import { fmtHuman, fmtSize } from '../../utils';
  import { thumbUrl } from '../../media';
  import {
    BITRATES,
    FORMATS,
    FRAME_RATES,
    GIF_FPS,
    GIF_MAX_SECS,
    GIF_WIDTH,
    RESOLUTIONS,
    SAMPLE_RATES,
    defaultFileName,
    estimateGifBytes,
    estimateMp3Bytes,
    FALLBACK_CAPS,
    formatPreset,
    formatValueLabel,
    frameRateLabel,
    mergeCaps,
    QUICK_PRESETS,
    resolutionValueLabel,
    stageLabel,
    targetFrame,
    etaSeconds,
    fmtClock
  } from '../../export-presets';
  import type { ExportCaps, QuickPresetId } from '../../export-presets';
  import type { ExportFormat, ResolutionId } from '../../export-presets';
  import { exportDefaults } from '../../stores/export-defaults.svelte';
  import ExportSelect from '../export/ExportSelect.svelte';
  import ExportHistoryPanel from '../export/ExportHistoryPanel.svelte';

  /**
   * MODE 3 — EXPORT. Image-approved layout: Quick / Advanced tabs, preset
   * cards, setting rows, preview + Ready-to-Export card. All of the old engine
   * logic (pieces, sequence, progress) is unchanged — only the chrome moved.
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
    { id: 'encode', label: 'Exact cuts', note: 're-encodes everything · frame-accurate but slow' }
  ];
  const QUALITIES = ['original', 'high', 'balanced', 'small'] as const;

  const PRESETS = [
    {
      id: 'fast',
      label: 'Fast',
      note: 'sirf cut ke kinare re-encode · baaki stream copy · sound ek hi pass me',
      engine: 'hybrid' as Engine,
      quality: 'high' as (typeof QUALITIES)[number]
    },
    {
      id: 'quality',
      label: 'Quality',
      note: 'har frame re-encode · near-lossless · sabse slow',
      engine: 'encode' as Engine,
      quality: 'original' as (typeof QUALITIES)[number]
    }
  ];

  let format = $state<ExportFormat>('video');
  let resolution = $state<ResolutionId>(exportDefaults.resolution);
  let engine = $state<Engine>('hybrid');
  let quality = $state<(typeof QUALITIES)[number]>('high');
  const activePreset = $derived(
    PRESETS.find((p) => p.engine === engine && p.quality === quality)?.id ?? null
  );
  let bitrate = $state<number>(192);
  let sampleRate = $state<number>(44100);
  let channels = $state<number>(2);
  let normalize = $state(false);
  let applyCuts = $state(true);
  let output = $state('');
  let outputTouched = $state(false);
  let running = $state(false);
  let aborted = false;
  let percent = $state(0);
  let stage = $state('');
  let message = $state('');
  let pieceIndex = $state(0);
  let pieceCount = $state(0);
  let result = $state<ExportResult | null>(null);
  let warnings = $state<string[]>([]);
  let progressBase = 0;
  let progressSpan = 100;

  // New screen state.
  let tab = $state<'quick' | 'advanced'>('quick');
  let moreOpen = $state(false);
  let canvasOverride = $state<[number, number] | null>(null);
  let fps = $state<number | null>(null);
  let includeAudio = $state(true);
  let codecChoice = $state('source');
  let crf = $state<number | null>(null);
  let twoPass = $state(false);
  let videoBitrate = $state<number | null>(null);
  let caps = $state<ExportCaps>(FALLBACK_CAPS);
  let historyOpen = $state(false);
  let logText = $state<string | null>(null);
  let logOpen = $state(false);
  let cancelArmed = $state(false);
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  let preflight = $state<{
    freeBytes: number;
    exists: boolean;
    ok: boolean;
    reason: string | null;
  } | null>(null);
  let overwriteArmed = $state(false);

  // Progress clocks.
  let startedAt = $state(0);
  let now = $state(0);
  let tickHandle: ReturnType<typeof setInterval> | null = null;

  const segments = $derived(
    project.orderedSegments
      .filter((s) => s.state === 'keep')
      .map((s) => ({
        start: s.startSec,
        end: s.endSec,
        gain: project.isSegmentMuted(s.id) ? 0 : project.segmentGain(s.id)
      }))
  );
  const extraClips = $derived(project.clips);
  const multiClip = $derived(project.clips.length > 0);
  const audioSecs = $derived(applyCuts ? project.keptSec : project.durationSec);
  const finalSecs = $derived(project.keptSec + project.extrasDuration);
  const frame = $derived(
    targetFrame(resolution, project.media?.width ?? 0, project.media?.height ?? 0)
  );
  const preset = $derived(formatPreset(format));
  const gifTooLong = $derived(project.keptSec > GIF_MAX_SECS);
  const estimated = $derived.by(() => {
    if (format === 'mp3') return estimateMp3Bytes(audioSecs, bitrate);
    if (format === 'gif')
      return estimateGifBytes(audioSecs, GIF_FPS, GIF_WIDTH, project.media?.height ?? 270);
    if (!project.media || project.media.sizeBytes <= 0) return 0;
    const base = (project.media.sizeBytes * project.keptSec) / Math.max(project.durationSec, 1);
    const scale = frame
      ? (frame.width * frame.height) / Math.max(project.media.width * project.media.height, 1)
      : 1;
    return Math.round(base * scale);
  });
  const browserCanExport = $derived(format === 'mp3');
  const canRun = $derived(
    multiClip
      ? isTauri() && !!project.sourcePath && segments.length > 0
      : format === 'gif'
        ? !gifTooLong && segments.length > 0
        : segments.length > 0 && (isTauri() ? !!project.sourcePath : browserCanExport)
  );
  const finalCanvas = $derived(canvasOverride ?? project.canvasFrame);
  const activeCard = $derived.by(() => {
    if (canvasOverride && canvasOverride[1] > canvasOverride[0]) return 'shorts' as QuickPresetId;
    if (resolution === '4k') return '4k' as QuickPresetId;
    if (resolution === '1080p') return 'youtube' as QuickPresetId;
    return 'custom' as QuickPresetId;
  });
  const sourceFps = $derived(project.media?.fps ?? 0);
  const frameRateText = $derived(frameRateLabel(fps, sourceFps));
  const fpsPending = $derived(!caps.fps && fps !== null && Math.round(sourceFps) !== fps);
  const resolutionText = $derived(
    resolutionValueLabel(resolution, project.media?.width ?? 0, project.media?.height ?? 0)
  );
  const formatText = $derived(formatValueLabel(format));
  const poster = $derived(project.thumbnails ? thumbUrl(project.thumbnails, 0) : null);
  const previewAspect = $derived.by(() => {
    const c = finalCanvas;
    if (c && c[0] && c[1]) return `${c[0]} / ${c[1]}`;
    const m = project.media;
    if (m && m.width && m.height) return `${m.width} / ${m.height}`;
    return '16 / 9';
  });
  const elapsedSecs = $derived(running && startedAt > 0 ? (now - startedAt) / 1000 : 0);
  const eta = $derived(etaSeconds(percent, elapsedSecs));
  const speedX = $derived.by(() => {
    if (!running || elapsedSecs <= 0 || percent <= 0 || finalSecs <= 0) return 0;
    const rendered = (percent / 100) * finalSecs;
    return rendered / elapsedSecs;
  });
  const showExtra = $derived(tab === 'advanced' || moreOpen);

  $effect(() => {
    if (multiClip && format !== 'video') format = 'video';
  });

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

  function defaultOutputName() {
    return defaultFileName(project.name, format);
  }
  function defaultOutputPath() {
    return exportDefaults.pathFor(defaultOutputName());
  }

  onMount(() => {
    void exportCapabilities().then((c) => (caps = mergeCaps(c)));
  });

  $effect(() => {
    if (!running) return;
    startedAt = Date.now();
    now = startedAt;
    const id = setInterval(() => (now = Date.now()), 1000);
    tickHandle = id;
    return () => {
      clearInterval(id);
      tickHandle = null;
    };
  });

  async function runSequence(
    out: string,
    options: ExportOptions,
    source: string,
    dbPath: string | null
  ): Promise<ExportResult> {
    const total = 1 + project.clips.length;
    const res: ResolutionId = resolution === 'source' ? '1080p' : resolution;
    const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
    const canvas = finalCanvas
      ? { width: finalCanvas[0], height: finalCanvas[1] }
      : (targetFrame(res, project.media?.width ?? 0, project.media?.height ?? 0) ?? {
          width: even(project.media?.width || 1920),
          height: even(project.media?.height || 1080)
        });
    const partOptions: ExportOptions = {
      ...options,
      mode: 'encode',
      format: 'video',
      resolution: res,
      canvas: [canvas.width, canvas.height]
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
        await stillClip(clip.path, clip.outSec - clip.inSec, part, canvas.width, canvas.height);
      } else {
        await startExport({
          source: clip.path,
          segments: [
            {
              start: clip.inSec,
              end: clip.outSec,
              gain: project.isSegmentMuted(clip.id) ? 0 : project.segmentGain(clip.id)
            }
          ],
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

  const formatOptions = FORMATS.map((f) => ({
    value: f.label,
    label: f.label,
    note: `.${f.ext} · ${f.note}`,
    disabled: multiClip && f.id !== 'video'
  }));

  const resolutionOptions = RESOLUTIONS.map((r) => ({
    value: r.id,
    label: r.label,
    note: r.note,
    disabled: multiClip && r.id === 'source'
  }));

  const fpsOptions = $derived([
    {
      value: 'source',
      label: frameRateLabel(null, sourceFps),
      note: "keep the recording's own rate"
    },
    ...FRAME_RATES.map((f) => ({
      value: String(f),
      label: `${f} FPS`,
      note: f === Math.round(sourceFps) ? 'matches source' : 're-encoded'
    }))
  ]);

  function handleFormat(label: string) {
    const f = FORMATS.find((x) => x.label === label);
    if (f) format = f.id;
  }

  function handleFps(value: string) {
    fps = value === 'source' ? null : Number(value);
  }

  function notify(title: string, body: string) {
    void appNotify(title, body).catch(() => {});
  }

  async function run(force = false) {
    if (running) return;
    const source = project.sourcePath;
    if (!source && !isTauri()) {
      if (!project.media?.url) {
        toast.push('warn', 'Pehle media load karo');
        return;
      }
    } else if (!source) {
      toast.push('warn', 'Pehle video load karo');
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

    const out = output || defaultOutputPath();
    output = out;

    // Pre-flight: disk space + overwrite.
    if (caps.preflight && isTauri() && !force) {
      const pf = await preflightExport(out, estimated);
      preflight = pf;
      if (pf && !pf.ok) {
        // exists → ask; low-space → block
        if (pf.reason === 'exists') return;
        if (pf.reason === 'low-space') {
          toast.push('warn', 'Disk par space kam hai — location change karo');
          return;
        }
        return;
      }
    } else {
      preflight = null;
    }

    running = true;
    aborted = false;
    percent = 0;
    pieceIndex = 0;
    pieceCount = 0;
    result = null;
    warnings = [];
    preflight = null;
    overwriteArmed = false;
    toast.push('info', multiClip ? 'Sequence export shuru…' : 'Export shuru…');
    notify(
      'T9EditorLIT',
      multiClip
        ? `Sequence export shuru — ${extraClips.length + 1} parts jodne hain`
        : 'Export shuru — cut aur encode chal raha hai'
    );

    const unlisten = await onExportProgress((p) => {
      percent = Math.min(99, progressBase + (p.percent / 100) * progressSpan);
      stage = p.stage;
      message = p.message;
      pieceIndex = p.pieceIndex ?? 0;
      pieceCount = p.pieceCount ?? 0;
    });

    try {
      const dbPath = await defaultDbPath().catch(() => null);
      const options: ExportOptions = {
        mode: engine,
        alignToleranceMs: 40,
        quality,
        format,
        resolution,
        canvas: format === 'video' ? finalCanvas : null,
        bitrateKbps: bitrate,
        sampleRate,
        channels,
        normalize,
        applyCuts,
        title: project.name,
        preset: activeCard,
        fps: fps ?? undefined,
        includeAudio,
        codec: codecChoice === 'source' ? undefined : codecChoice,
        container: undefined,
        crf: crf ?? undefined,
        videoBitrateKbps: videoBitrate ?? undefined,
        twoPass
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
      project.noteExport();
      toast.push('info', `Export done · ${fmtSize(res.sizeBytes)}`);
      notify(
        'Export done',
        `${(res.output || 'file').split(/[\\/]/).pop()} · ${fmtSize(res.sizeBytes)} · ${res.durationSecs.toFixed(1)}s`
      );
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (aborted) toast.push('info', 'Export cancelled');
      else {
        toast.push('warn', `Export failed: ${why}`);
        notify('Export failed', why);
      }
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

  function armCancel() {
    if (cancelArmed) {
      cancel();
      cancelArmed = false;
      if (cancelTimer) {
        clearTimeout(cancelTimer);
        cancelTimer = null;
      }
      return;
    }
    cancelArmed = true;
    if (cancelTimer) clearTimeout(cancelTimer);
    cancelTimer = setTimeout(() => {
      cancelArmed = false;
      cancelTimer = null;
    }, 3000);
  }

  function resetResult() {
    result = null;
    percent = 0;
    stage = '';
    message = '';
    warnings = [];
  }

  async function openResult() {
    if (result?.output) await openPath(result.output);
  }
  async function showResult() {
    if (result?.output) await revealPath(result.output);
  }

  function selectPreset(id: QuickPresetId) {
    const p = QUICK_PRESETS.find((q) => q.id === id);
    if (!p) return;
    if (id === 'custom') {
      tab = 'advanced';
      return;
    }
    if (p.resolution) resolution = p.resolution;
    canvasOverride = p.canvas;
    tab = 'quick';
  }

  async function toggleLog() {
    if (logOpen) {
      logOpen = false;
      return;
    }
    const t = await readExportLog();
    logText = t;
    logOpen = true;
  }

  function fmtRate(n: number): string {
    return n > 0 ? `${n.toFixed(2)}×` : '—';
  }
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col bg-nc-bg">
  <!-- header -->
  <header class="flex shrink-0 items-start gap-3 border-b border-nc-line bg-nc-panel px-5 py-3">
    <span
      class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-nc-brand to-[#7b5cff] text-white shadow-lg shadow-nc-brand/20"
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        class="h-5 w-5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="3" y="8" width="18" height="12" rx="2" />
        <path d="M3 8 5 4h4l-2 4M9 8l2-4h4l-2 4M15 8l2-4h2a2 2 0 0 1 2 2v2" />
        <path d="m11 12 4 2-4 2z" fill="currentColor" stroke="none" />
      </svg>
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2">
        <h1 class="text-lg font-bold leading-tight">Export Video</h1>
        <span class="rounded bg-nc-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-nc-mut">
          {segments.length} segment{segments.length === 1 ? '' : 's'}
        </span>
        {#if multiClip}
          <span class="rounded bg-nc-brand/15 px-1.5 py-0.5 font-mono text-[10px] text-nc-brand">
            + {extraClips.length} clip{extraClips.length === 1 ? '' : 's'}
          </span>
        {/if}
        {#if !isTauri()}
          <span class="text-[10px] text-nc-mut-2">
            {browserCanExport
              ? 'Dev server FFmpeg se render hota hai'
              : 'Desktop app me chalta hai'}
          </span>
        {/if}
      </div>
      <p class="mt-0.5 text-[11px] text-nc-mut">Share your creativity with the world ✨</p>
      <p class="mt-0.5 font-mono text-[10px] text-nc-mut-2">
        FINAL {fmtHuman(finalSecs)} · CUT {fmtHuman(project.cutSec)} · RAW {fmtHuman(
          project.durationSec
        )}
      </p>
    </div>
    <button
      type="button"
      onclick={() => (historyOpen = true)}
      class="flex shrink-0 items-center gap-1.5 rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2 text-[11px] font-semibold text-nc-mut transition-colors hover:border-nc-brand/50 hover:text-nc-txt"
      title="Previous exports"
    >
      <svg
        viewBox="0 0 24 24"
        class="h-3.5 w-3.5"
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
      Export History
    </button>
  </header>

  <div class="nc-scroll min-h-0 flex-1 p-5">
    <div class="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <!-- LEFT -->
      <div class="min-w-0 space-y-4">
        <!-- tabs -->
        <div class="flex rounded-xl border border-nc-line bg-nc-panel p-1">
          <button
            type="button"
            onclick={() => (tab = 'quick')}
            class="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors
                   {tab === 'quick'
              ? 'bg-nc-brand text-white shadow'
              : 'text-nc-mut hover:text-nc-txt'}"
          >
            <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="currentColor" aria-hidden="true"
              ><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></svg
            >
            Quick Export ⚡
          </button>
          <button
            type="button"
            onclick={() => (tab = 'advanced')}
            class="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors
                   {tab === 'advanced'
              ? 'bg-nc-brand text-white shadow'
              : 'text-nc-mut hover:text-nc-txt'}"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
              <circle cx="16" cy="7" r="2" />
              <circle cx="10" cy="17" r="2" />
            </svg>
            Advanced
          </button>
        </div>

        <!-- preset cards -->
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {#each QUICK_PRESETS as p (p.id)}
            {@const selected = activeCard === p.id}
            <button
              type="button"
              onclick={() => selectPreset(p.id)}
              class="relative flex flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors
                     {selected
                ? 'border-nc-brand bg-nc-brand/5'
                : 'border-nc-line bg-nc-panel hover:border-nc-line-2'}"
            >
              {#if selected}
                <span
                  class="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-nc-brand text-white"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="h-2.5 w-2.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                </span>
              {/if}
              <span class="flex h-7 items-center gap-1.5">
                {#if p.id === 'youtube'}
                  <span
                    class="grid h-6 w-9 place-items-center rounded-md bg-[#ff0000] text-[9px] font-black text-white"
                    >YT</span
                  >
                {:else if p.id === 'shorts'}
                  <span
                    class="grid h-6 w-5 place-items-center rounded-md bg-gradient-to-b from-[#ff0000] to-[#7b1fa2] text-[9px] font-black text-white"
                    >S</span
                  >
                {:else if p.id === '4k'}
                  <span
                    class="grid h-6 w-9 place-items-center rounded-md border border-nc-amber bg-nc-amber/10 text-[9px] font-black text-nc-amber"
                    >4K</span
                  >
                {:else}
                  <span
                    class="grid h-6 w-6 place-items-center rounded-md border border-nc-line-2 text-nc-mut"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      class="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m12 3 2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.4l6-.9z" />
                    </svg>
                  </span>
                {/if}
              </span>
              <span class="min-w-0">
                <span class="block text-xs font-semibold leading-tight text-nc-txt">{p.label}</span>
                <span class="block text-[10px] leading-tight text-nc-mut">{p.note}</span>
              </span>
            </button>
          {/each}
        </div>

        <!-- setting rows -->
        <div class="space-y-2.5">
          <ExportSelect
            label="Format"
            value={format}
            display={formatText}
            soon={false}
            icon={formatIcon}
            options={FORMATS.map((f) => ({
              value: f.id,
              label: f.label,
              note: `.${f.ext} · ${f.note}`,
              disabled: multiClip && f.id !== 'video'
            }))}
            onselect={(v: string) => (format = v as ExportFormat)}
          />
          <ExportSelect
            label="Resolution"
            value={resolution}
            display={resolutionText}
            icon={monitorIcon}
            options={RESOLUTIONS.map((r) => ({
              value: r.id,
              label: r.label,
              note: r.note,
              disabled: multiClip && r.id === 'source'
            }))}
            onselect={(v: string) => {
              resolution = v as ResolutionId;
              canvasOverride = null;
            }}
          />
          <ExportSelect
            label="Frame Rate"
            value={fps === null ? 'source' : String(fps)}
            display={frameRateText}
            soon={fpsPending}
            icon={gaugeIcon}
            options={[
              {
                value: 'source',
                label: frameRateLabel(null, sourceFps),
                note: "keep the recording's own rate"
              },
              ...FRAME_RATES.map((f) => ({
                value: String(f),
                label: `${f} FPS`,
                note: f === Math.round(sourceFps) ? 'matches source' : 're-encoded'
              }))
            ]}
            onselect={handleFps}
          />
          <div
            class="flex items-center gap-3 rounded-xl border border-nc-line bg-nc-panel px-3 py-2.5"
          >
            <span
              class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-nc-panel-2 text-nc-mut"
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 24 24"
                class="h-4 w-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 9v6h4l5 4V5L8 9z" />
                <path d="M16 9a4 4 0 0 1 0 6" />
              </svg>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-[11px] leading-tight text-nc-mut">Include Audio</span>
              <span class="block text-sm font-semibold leading-tight text-nc-txt">
                {includeAudio ? 'On' : 'Off'}
              </span>
            </span>
            {#if !caps.includeAudio && !includeAudio}
              <span
                class="rounded bg-nc-amber/15 px-1.5 py-0.5 text-[9px] font-bold text-nc-amber"
                title="Backend update (EXPORT.md B1-2) ke baad apply hoga">SOON</span
              >
            {/if}
            <button
              type="button"
              role="switch"
              aria-checked={includeAudio}
              aria-label="Include Audio"
              onclick={() => (includeAudio = !includeAudio)}
              class="relative h-6 w-11 shrink-0 rounded-full transition-colors {includeAudio
                ? 'bg-nc-brand'
                : 'bg-nc-panel-2'}"
            >
              <span
                class="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform {includeAudio
                  ? 'translate-x-5'
                  : 'translate-x-0.5'}"
              ></span>
            </button>
          </div>
        </div>

        {#if showExtra}
          <div class="space-y-4">
            {#if format === 'video'}
              <section class="rounded-xl border border-nc-line bg-nc-panel p-4">
                <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-mut">
                  SPEED · QUALITY
                </h3>
                <div class="grid grid-cols-2 gap-2">
                  {#each PRESETS as p (p.id)}
                    <button
                      type="button"
                      onclick={() => {
                        engine = p.engine;
                        quality = p.quality;
                      }}
                      aria-pressed={activePreset === p.id}
                      class="rounded-lg border px-3 py-2.5 text-left transition-colors
                             {activePreset === p.id
                        ? 'border-nc-brand bg-nc-brand/5'
                        : 'border-nc-line bg-nc-panel-2 hover:border-nc-line-2'}"
                    >
                      <span class="block text-xs font-semibold">{p.label}</span>
                      <span class="mt-0.5 block text-[10px] leading-snug text-nc-mut">{p.note}</span
                      >
                    </button>
                  {/each}
                </div>
                {#if estimated > 0}
                  <p class="mt-2 font-mono text-[10px] text-nc-mut-2">≈ {fmtSize(estimated)}</p>
                {/if}
                <details class="mt-3 rounded-lg border border-nc-line bg-nc-panel-2/40 px-3 py-2">
                  <summary class="cursor-pointer select-none text-[11px] text-nc-mut">
                    Advanced — engine &amp; encoder quality
                    {#if activePreset === null}<span class="text-nc-brand">· custom</span>{/if}
                  </summary>
                  <div class="mt-3 grid gap-2">
                    {#each ENGINES as e (e.id)}
                      <button
                        type="button"
                        onclick={() => (engine = e.id)}
                        class="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors
                               {engine === e.id
                          ? 'border-nc-brand bg-nc-brand/5'
                          : 'border-nc-line bg-nc-panel hover:border-nc-line-2'}"
                      >
                        <span
                          class="grid h-4 w-4 shrink-0 place-items-center rounded-full border {engine ===
                          e.id
                            ? 'border-nc-brand'
                            : 'border-nc-line-2'}"
                        >
                          {#if engine === e.id}<span class="h-2 w-2 rounded-full bg-nc-brand"
                            ></span>{/if}
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
                          type="button"
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
                  </div>
                </details>
              </section>

              <section class="rounded-xl border border-nc-line bg-nc-panel p-4">
                <div class="flex items-center justify-between gap-2">
                  <h3 class="text-[10px] font-bold tracking-widest text-nc-mut">
                    CODEC &amp; RATE CONTROL
                  </h3>
                  <span
                    class="rounded bg-nc-amber/15 px-1.5 py-0.5 text-[9px] font-bold text-nc-amber"
                    title="EXPORT.md B1-2 / B1-4 ke baad live hoga">ENGINE UPDATE PENDING</span
                  >
                </div>
                <p class="mt-1 text-[10px] text-nc-mut-2">
                  H.264 / H.265 / AV1, CRF, video bitrate + 2-pass tab aaenge jab backend land kare.
                  Abhi UI ready hai, engine wiring pending.
                </p>
                <div class="mt-3 grid gap-2 sm:grid-cols-2">
                  <div class="rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2 opacity-60">
                    <p class="text-[10px] text-nc-mut">Codec</p>
                    <p class="text-xs font-semibold text-nc-txt">H.264 (source family)</p>
                  </div>
                  <div class="rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2 opacity-60">
                    <p class="text-[10px] text-nc-mut">CRF / Bitrate</p>
                    <p class="text-xs font-semibold text-nc-txt">Quality ladder (auto)</p>
                  </div>
                </div>
              </section>
            {/if}

            {#if format === 'gif'}
              <section class="rounded-xl border border-nc-line bg-nc-panel p-4">
                <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-mut">GIF</h3>
                <div class="rounded-lg border border-nc-line bg-nc-panel-2 p-3">
                  <p class="text-[11px] text-nc-mut">
                    {GIF_FPS} fps · {GIF_WIDTH} px wide · looping · palette-optimised
                  </p>
                  <p class="mt-1 text-[10px] text-nc-mut-2">
                    GIF sirf {GIF_MAX_SECS} second tak ke clip ke liye hai.
                  </p>
                  {#if gifTooLong}
                    <p class="mt-2 text-[10px] text-nc-red">
                      · Ye cut {fmtHuman(project.keptSec)} ka hai — GIF nahi ban sakta. Video ya MP3 chuna
                      lo.
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
                    <span class="ml-auto font-mono text-[10px] text-nc-mut-2"
                      >≈ {fmtSize(estimated)}</span
                    >
                  {/if}
                </div>
              </section>
            {/if}

            {#if format === 'mp3'}
              <section class="rounded-xl border border-nc-line bg-nc-panel p-4">
                <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-mut">
                  AUDIO ONLY · MP3
                </h3>
                <div class="rounded-lg border border-nc-line bg-nc-panel-2 p-3">
                  <p class="text-[11px] text-nc-mut">
                    Music, AI voiceover, recording ya video ka dialogue — ek MP3, bilkul nahi
                    picture.
                  </p>
                </div>
                <div class="mt-3 flex items-center gap-3">
                  <span class="text-[11px] text-nc-mut">Bitrate</span>
                  <div class="flex gap-1">
                    {#each BITRATES as b (b)}
                      <button
                        type="button"
                        onclick={() => (bitrate = b)}
                        class="rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors {bitrate ===
                        b
                          ? 'bg-nc-brand text-nc-bg'
                          : 'bg-nc-panel-2 text-nc-mut hover:text-nc-txt'}">{b}k</button
                      >
                    {/each}
                  </div>
                  {#if estimated > 0}
                    <span class="ml-auto font-mono text-[10px] text-nc-mut-2"
                      >≈ {fmtSize(estimated)}</span
                    >
                  {/if}
                </div>
                <div class="mt-3 flex items-center gap-3">
                  <span class="text-[11px] text-nc-mut">Sample rate</span>
                  <div class="flex gap-1">
                    {#each SAMPLE_RATES as sr (sr)}
                      <button
                        type="button"
                        onclick={() => (sampleRate = sr)}
                        class="rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors {sampleRate ===
                        sr
                          ? 'bg-nc-brand text-nc-bg'
                          : 'bg-nc-panel-2 text-nc-mut hover:text-nc-txt'}"
                        >{sr === 44100 ? '44.1 kHz' : '48 kHz'}</button
                      >
                    {/each}
                  </div>
                  <span class="text-[11px] text-nc-mut">Channels</span>
                  <div class="flex gap-1">
                    <button
                      type="button"
                      onclick={() => (channels = 2)}
                      class="rounded-md px-2.5 py-1 text-[11px] transition-colors {channels === 2
                        ? 'bg-nc-brand text-nc-bg'
                        : 'bg-nc-panel-2 text-nc-mut hover:text-nc-txt'}">Stereo</button
                    >
                    <button
                      type="button"
                      onclick={() => (channels = 1)}
                      class="rounded-md px-2.5 py-1 text-[11px] transition-colors {channels === 1
                        ? 'bg-nc-brand text-nc-bg'
                        : 'bg-nc-panel-2 text-nc-mut hover:text-nc-txt'}">Mono</button
                    >
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
                  <span class="ml-auto font-mono text-[10px] text-nc-mut-2"
                    >{fmtHuman(audioSecs)} audio</span
                  >
                </div>
              </section>
            {/if}

            <section class="rounded-xl border border-nc-line bg-nc-panel p-4">
              <h3 class="mb-2 text-[10px] font-bold tracking-widest text-nc-mut">OUTPUT</h3>
              <div class="flex gap-2">
                <input
                  value={output}
                  oninput={(e) => {
                    outputTouched = true;
                    output = e.currentTarget.value;
                  }}
                  placeholder={defaultOutputPath()}
                  class="min-w-0 flex-1 rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2 font-mono text-[11px] outline-none focus:border-nc-brand/50"
                />
                <button
                  type="button"
                  onclick={chooseOutput}
                  class="rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2 text-[11px] hover:border-nc-brand/50"
                >
                  Choose…
                </button>
              </div>
            </section>

            {#if caps.logs}
              <section class="rounded-xl border border-nc-line bg-nc-panel p-4">
                <div class="flex items-center justify-between gap-2">
                  <h3 class="text-[10px] font-bold tracking-widest text-nc-mut">EXPORT LOG</h3>
                  <button
                    type="button"
                    onclick={toggleLog}
                    class="rounded-md border border-nc-line bg-nc-panel-2 px-2 py-1 text-[10px] text-nc-mut hover:text-nc-txt"
                  >
                    {logOpen ? 'Hide' : 'View last'}
                  </button>
                </div>
                {#if logOpen}
                  {#if logText}
                    <pre
                      class="mt-2 max-h-48 overflow-auto rounded-lg bg-nc-bg p-2 font-mono text-[9px] text-nc-mut">{logText}</pre>
                  {:else}
                    <p class="mt-2 text-[10px] text-nc-mut-2">Koi log nahi mila.</p>
                  {/if}
                {/if}
              </section>
            {/if}
          </div>
        {/if}

        {#if multiClip}
          <p class="text-[11px] leading-relaxed text-nc-mut">
            Timeline pe <b class="text-nc-brand">{extraClips.length}</b> extra clip
            {extraClips.length === 1 ? 'hai' : 'hain'} — poora sequence ek MP4 me jayega. Main cut pehle,
            phir har clip; aakhir me ek stream-copy join.
          </p>
        {/if}

        <!-- output location row -->
        <div
          class="flex items-center gap-3 rounded-xl border border-nc-line bg-nc-panel px-3 py-2.5"
        >
          <span
            class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-nc-panel-2 text-nc-mut"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-4 w-4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
            </svg>
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-[11px] leading-tight text-nc-mut">Output Location</p>
            <p
              class="truncate font-mono text-xs leading-tight text-nc-txt"
              title={output || defaultOutputPath()}
            >
              {output || defaultOutputPath()}
            </p>
          </div>
          <button
            type="button"
            onclick={chooseOutput}
            class="shrink-0 rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-1.5 text-[11px] hover:border-nc-brand/50"
          >
            Change
          </button>
        </div>

        {#if tab === 'quick' && !moreOpen}
          <button
            type="button"
            onclick={() => (moreOpen = true)}
            class="mx-auto flex items-center gap-1 text-[12px] font-semibold text-nc-brand hover:underline"
          >
            More Options
            <svg
              viewBox="0 0 24 24"
              class="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        {/if}
      </div>

      <!-- RIGHT -->
      <div class="space-y-4">
        <!-- preview card -->
        <div class="overflow-hidden rounded-2xl border border-nc-line bg-nc-panel">
          <div class="relative w-full bg-nc-bg" style="aspect-ratio: {previewAspect}">
            {#if poster}
              <img src={poster} alt="preview" class="h-full w-full object-cover opacity-80" />
            {:else}
              <div class="grid h-full w-full place-items-center text-nc-mut-2">
                <svg
                  viewBox="0 0 24 24"
                  class="h-10 w-10"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m10 9 6 3-6 3z" fill="currentColor" stroke="none" />
                </svg>
              </div>
            {/if}
            <button
              type="button"
              onclick={async () => {
                if (project.sourcePath) await openPath(project.sourcePath);
              }}
              class="absolute left-1/2 top-1/2 grid h-14 w-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/15 text-white backdrop-blur-md transition hover:bg-white/25"
              title="Source kholo"
              aria-label="Play source"
            >
              <svg
                viewBox="0 0 24 24"
                class="h-6 w-6 translate-x-0.5"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          </div>
        </div>

        <!-- status card -->
        {#if preflight && preflight.reason === 'exists' && !overwriteArmed}
          <div class="space-y-3 rounded-2xl border border-nc-amber/40 bg-nc-amber/5 p-4">
            <div class="flex items-center gap-2">
              <span class="grid h-8 w-8 place-items-center rounded-lg bg-nc-amber/15 text-nc-amber">
                <svg
                  viewBox="0 0 24 24"
                  class="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                  ><path
                    d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
                  /><path d="M12 9v4M12 17h.01" /></svg
                >
              </span>
              <div class="min-w-0 flex-1">
                <p class="text-xs font-bold text-nc-amber">File already exists</p>
                <p class="truncate text-[10px] text-nc-mut" title={output}>
                  {output.split(/[\\/]/).pop()}
                </p>
              </div>
            </div>
            <div class="flex gap-2">
              <button
                type="button"
                onclick={() => {
                  overwriteArmed = true;
                  run(true);
                }}
                class="flex-1 rounded-lg bg-nc-brand py-2 text-[11px] font-bold text-nc-bg hover:brightness-110"
                >Overwrite &amp; Export</button
              >
              <button
                type="button"
                onclick={() => {
                  preflight = null;
                  chooseOutput();
                }}
                class="rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2 text-[11px] text-nc-mut hover:text-nc-txt"
                >Change location</button
              >
            </div>
          </div>
        {:else if running}
          <div class="space-y-3 rounded-2xl border border-nc-brand/40 bg-nc-brand/5 p-4">
            <div class="flex items-center gap-2">
              <span class="grid h-8 w-8 place-items-center rounded-lg bg-nc-brand/15 text-nc-brand">
                <svg
                  viewBox="0 0 24 24"
                  class="h-4 w-4 animate-spin"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M12 2a10 10 0 0 1 10 10" />
                </svg>
              </span>
              <div class="min-w-0 flex-1">
                <p class="text-xs font-bold text-nc-brand">{stageLabel(stage) || 'Working'}</p>
                <p class="truncate text-[10px] text-nc-mut">{message || 'Export chal raha hai…'}</p>
              </div>
              <span class="font-mono text-lg font-bold text-nc-txt">{percent.toFixed(0)}%</span>
            </div>
            <div class="h-2 overflow-hidden rounded-full bg-nc-panel-2">
              <div
                class="h-full rounded-full bg-gradient-to-r from-nc-brand to-[#6a5cff] transition-[width] duration-200"
                style="width:{percent}%"
              ></div>
            </div>
            <div class="flex items-center justify-between font-mono text-[10px] text-nc-mut">
              <span>piece {pieceIndex || 1}/{pieceCount || 1}</span>
              <span
                >{fmtClock(elapsedSecs)} elapsed{eta !== null
                  ? ` · ${fmtClock(eta)} left`
                  : ''}</span
              >
            </div>
            {#if speedX > 0}
              <p class="font-mono text-[10px] text-nc-mut-2">{fmtRate(speedX)} realtime</p>
            {/if}
            <button
              type="button"
              onclick={armCancel}
              class="w-full rounded-lg border py-1.5 text-[11px] transition-colors
                     {cancelArmed
                ? 'border-nc-red bg-nc-red/10 text-nc-red'
                : 'border-nc-line text-nc-mut hover:text-nc-txt'}"
            >
              {cancelArmed ? 'Confirm cancel? (3s)' : 'Cancel'}
            </button>
          </div>
        {:else if result}
          <div
            class="nc-tie-edge space-y-3 rounded-2xl border border-nc-brand/40 bg-nc-brand/5 p-4 text-center"
          >
            <p class="text-base font-bold text-nc-brand">Export complete</p>
            <p class="text-xs text-nc-mut">
              {result.pieceCount} piece{result.pieceCount === 1 ? '' : 's'} · {fmtSize(
                result.sizeBytes
              )} · {fmtHuman(result.durationSecs)}
            </p>
            {#if result.encoder}
              <p class="font-mono text-[10px] text-nc-mut-2">encoder: {result.encoder}</p>
            {/if}
            <p class="break-all font-mono text-[10px] text-nc-mut-2">{result.output}</p>
            {#if warnings.length}
              <ul class="space-y-1 text-left text-[10px] text-nc-red">
                {#each warnings as w (w)}<li>· {w}</li>{/each}
              </ul>
            {/if}
            <div class="flex gap-2">
              <button
                type="button"
                onclick={openResult}
                class="flex-1 rounded-lg bg-nc-brand py-2 text-[11px] font-bold text-nc-bg hover:brightness-110"
                >▶ Play</button
              >
              <button
                type="button"
                onclick={showResult}
                class="flex-1 rounded-lg border border-nc-line bg-nc-panel-2 py-2 text-[11px] text-nc-mut hover:text-nc-txt"
                >Show in folder</button
              >
            </div>
            <button
              type="button"
              onclick={resetResult}
              class="text-[10px] text-nc-mut-2 hover:text-nc-txt">Export again</button
            >
          </div>
        {:else}
          <div class="space-y-3 rounded-2xl border border-nc-line bg-nc-panel p-4">
            <div class="flex items-center gap-3">
              <span
                class="grid h-10 w-10 place-items-center rounded-xl bg-nc-brand/10 text-nc-brand"
              >
                <svg
                  viewBox="0 0 24 24"
                  class="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
                </svg>
              </span>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-bold text-nc-txt">Ready to Export</p>
                <p class="text-[11px] text-nc-mut">
                  Estimated file size: ~ {fmtSize(estimated) || '—'}
                </p>
              </div>
            </div>
            {#if !canRun}
              <p class="text-[10px] text-nc-mut-2">
                {#if segments.length === 0}Kuch bacha hi nahi — sab cut hai.
                {:else if format === 'gif' && gifTooLong}GIF sirf {GIF_MAX_SECS}s tak ka hai.
                {:else if multiClip && !isTauri()}Multi-clip export desktop app me chalta hai.
                {:else if !isTauri() && !browserCanExport}Desktop app me chalta hai.
                {:else}Export ke liye media load karo.{/if}
              </p>
            {/if}
            <button
              type="button"
              onclick={() => run(false)}
              disabled={!canRun}
              class="w-full rounded-xl bg-gradient-to-r from-nc-brand to-[#6a5cff] py-3.5 text-sm font-bold text-white shadow-lg shadow-nc-brand/20 transition hover:brightness-110 disabled:opacity-40 disabled:shadow-none"
            >
              Export Video ↑
            </button>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <ExportHistoryPanel bind:open={historyOpen} {caps} />
</div>

<!-- icon snippets -->
{#snippet formatIcon()}
  <svg
    viewBox="0 0 24 24"
    class="h-4 w-4"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M6 3h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M13 3v5h5" />
  </svg>
{/snippet}
{#snippet monitorIcon()}
  <svg
    viewBox="0 0 24 24"
    class="h-4 w-4"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
{/snippet}
{#snippet gaugeIcon()}
  <svg
    viewBox="0 0 24 24"
    class="h-4 w-4"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4 14a8 8 0 1 1 16 0" />
    <path d="M12 14l4-4" />
    <circle cx="12" cy="14" r="1.5" />
  </svg>
{/snippet}
