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
    CONTAINERS,
    RECOMMENDED_EXPORT,
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
    estimateWavBytes,
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

  /**
   * Each destination gets its own colour identity — YouTube red, Shorts
   * pink-violet, 4K amber, Custom violet — so the four cards read as four
   * different places to publish instead of four identical gray boxes.
   * The class strings live here as literals so Tailwind can see them.
   */
  const CARD_SKIN: Record<string, { active: string; hover: string; glow: string; icon: string }> = {
    youtube: {
      active: 'border-[#ff4d4d]/70 bg-[#ff4d4d]/5',
      hover: 'hover:border-[#ff4d4d]/45 hover:bg-[#ff4d4d]/5',
      glow: 'shadow-[0_0_28px_-8px_#ff4d4d]',
      icon: 'text-[#ff6b6b]'
    },
    shorts: {
      active: 'border-[#ff3d8b]/70 bg-[#ff3d8b]/5',
      hover: 'hover:border-[#ff3d8b]/45 hover:bg-[#ff3d8b]/5',
      glow: 'shadow-[0_0_28px_-8px_#ff3d8b]',
      icon: 'text-[#ff6ba8]'
    },
    '4k': {
      active: 'border-nc-amber/70 bg-nc-amber/5',
      hover: 'hover:border-nc-amber/45 hover:bg-nc-amber/5',
      glow: 'shadow-[0_0_28px_-8px_#e0a94f]',
      icon: 'text-nc-amber'
    },
    custom: {
      active: 'border-[#7b5cff]/70 bg-[#7b5cff]/5',
      hover: 'hover:border-[#7b5cff]/45 hover:bg-[#7b5cff]/5',
      glow: 'shadow-[0_0_28px_-8px_#7b5cff]',
      icon: 'text-[#9b8cff]'
    }
  };

  let format = $state<ExportFormat>('video');
  let resolution = $state<ResolutionId>(exportDefaults.resolution);
  let engine = $state<Engine>('hybrid');
  let quality = $state<(typeof QUALITIES)[number]>('high');
  const activePreset = $derived(
    PRESETS.find((p) => p.engine === engine && p.quality === quality)?.id ?? null
  );
  // App-recommended defaults: quality first, still fully editable.
  let bitrate = $state<number>(RECOMMENDED_EXPORT.bitrate);
  let sampleRate = $state<number>(RECOMMENDED_EXPORT.sampleRate);
  let channels = $state<number>(RECOMMENDED_EXPORT.channels);
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
  let fps = $state<number | null>(RECOMMENDED_EXPORT.fps);
  let includeAudio = $state(RECOMMENDED_EXPORT.includeAudio);
  let codecChoice = $state(RECOMMENDED_EXPORT.codec);
  let crf = $state<number | null>(RECOMMENDED_EXPORT.crf);
  let twoPass = $state(RECOMMENDED_EXPORT.twoPass);
  let videoBitrate = $state<number | null>(null);
  let containerChoice = $state(RECOMMENDED_EXPORT.container);
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
    if (format === 'wav') return estimateWavBytes(audioSecs, sampleRate, channels);
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
    const wanted =
      format === 'video'
        ? (CONTAINERS.find((c) => c.id === containerChoice)?.ext ?? preset.ext)
        : preset.ext;
    const ext = output.split('.').pop()?.toLowerCase() ?? '';
    // A format switch must never leave a stale .mp4 name on an MP3/WAV job:
    // the audio engine rejects every extension but its own. The container
    // choice decides the video extension so FFmpeg picks the right muxer.
    if (!outputTouched || ext !== wanted) {
      const path = exportDefaults.pathFor(defaultFileName(project.name, format));
      output = wanted === preset.ext ? path : path.replace(/\.[^.]+$/, `.${wanted}`);
      outputTouched = false;
    }
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
        container: format === 'video' && caps.container ? containerChoice : undefined,
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

<div class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-nc-bg">
  <!-- ambient light: two soft brand glows so the screen has a light source -->
  <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
    <div class="absolute -left-24 -top-32 h-96 w-96 rounded-full bg-nc-brand/16 blur-[110px]"></div>
    <div
      class="absolute -right-32 top-1/3 h-80 w-80 rounded-full bg-[#7b5cff]/12 blur-[110px]"
    ></div>
    <div
      class="absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,transparent,var(--color-nc-bg)_72%)]"
    ></div>
  </div>

  <!-- header -->
  <header
    class="relative z-10 flex shrink-0 items-start gap-3.5 border-b border-nc-line/70 bg-nc-panel/70 px-6 py-4 backdrop-blur-sm"
  >
    <span
      class="nc-icon-tile grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-nc-brand to-[#7b5cff] text-white shadow-[0_8px_24px_-8px_rgba(77,141,255,0.8)]"
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        class="h-5.5 w-5.5"
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
        <h1 class="nc-display text-xl font-extrabold tracking-tight">Export Video</h1>
        <span
          class="rounded-md border border-nc-line/80 bg-nc-panel-2/70 px-2 py-0.5 font-mono text-[10px] font-medium text-nc-mut"
        >
          {segments.length} segment{segments.length === 1 ? '' : 's'}
        </span>
        {#if multiClip}
          <span
            class="rounded-md border border-nc-brand/30 bg-nc-brand/12 px-2 py-0.5 font-mono text-[10px] font-medium text-nc-brand"
          >
            + {extraClips.length} clip{extraClips.length === 1 ? '' : 's'}
          </span>
        {/if}
      </div>
      <p class="mt-1 flex items-center gap-2 font-mono text-[10px] tracking-wide text-nc-mut-2">
        <span class="inline-block h-1 w-1 rounded-full bg-nc-green"></span>
        FINAL {fmtHuman(finalSecs)}
        <span class="text-nc-line-2">·</span>
        CUT {fmtHuman(project.cutSec)}
        <span class="text-nc-line-2">·</span>
        RAW {fmtHuman(project.durationSec)}
      </p>
    </div>
    <button
      type="button"
      onclick={() => (historyOpen = true)}
      class="nc-hover-lift flex shrink-0 items-center gap-2 rounded-xl border border-nc-line bg-nc-panel-2/70 px-3.5 py-2.5 text-[11px] font-semibold text-nc-mut backdrop-blur transition-all hover:border-nc-brand/50 hover:text-nc-txt"
      title="Previous exports"
    >
      <svg
        viewBox="0 0 24 24"
        class="h-4 w-4"
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

  <div class="nc-scroll relative z-10 min-h-0 flex-1 p-6">
    <div class="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <!-- LEFT -->
      <div class="min-w-0 space-y-5">
        <!-- tabs -->
        <div
          class="nc-segmented relative flex rounded-2xl border border-nc-line/80 bg-nc-panel/60 p-1.5 backdrop-blur"
        >
          <span
            class="absolute bottom-1.5 left-1.5 top-1.5 w-[calc(50%-0.375rem)] rounded-xl bg-gradient-to-r from-nc-brand to-[#6a5cff] shadow-[0_6px_20px_-6px_rgba(77,141,255,0.9)] transition-transform duration-300 ease-out
            {tab === 'quick' ? 'translate-x-0' : 'translate-x-full'}"
            aria-hidden="true"
          ></span>
          <button
            type="button"
            onclick={() => (tab = 'quick')}
            aria-pressed={tab === 'quick'}
            class="relative z-10 flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[12.5px] font-bold transition-colors duration-200
              {tab === 'quick' ? 'text-white' : 'text-nc-mut hover:text-nc-txt'}"
          >
            <svg viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor" aria-hidden="true"
              ><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></svg
            >
            Quick Export
          </button>
          <button
            type="button"
            onclick={() => (tab = 'advanced')}
            aria-pressed={tab === 'advanced'}
            class="relative z-10 flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[12.5px] font-bold transition-colors duration-200
              {tab === 'advanced' ? 'text-white' : 'text-nc-mut hover:text-nc-txt'}"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-4 w-4"
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

        <!-- preset cards: each destination keeps its own colour + frame shape -->
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {#each QUICK_PRESETS as p, i (p.id)}
            {@const selected = activeCard === p.id}
            {@const skin = CARD_SKIN[p.id]}
            <button
              type="button"
              onclick={() => selectPreset(p.id)}
              aria-pressed={selected}
              style="--i:{i}"
              class="nc-card-in group relative flex flex-col items-stretch gap-3 overflow-hidden rounded-2xl border p-3.5 text-left transition-all duration-200
                     {selected
                ? `${skin.active} ${skin.glow}`
                : `border-nc-line bg-nc-panel/80 hover:-translate-y-0.5 hover:border-nc-line-2 hover:shadow-lg hover:shadow-black/30 ${skin.hover}`}"
            >
              <!-- frame-shape mockup: the actual aspect ratio you are choosing -->
              <span
                class="relative grid h-14 w-full place-items-center rounded-lg border border-white/6 bg-black/30"
                aria-hidden="true"
              >
                {#if p.id === 'shorts'}
                  <span class="h-10 w-[22px] rounded-[5px] border-2 border-current {skin.icon}"
                  ></span>
                {:else if p.id === 'youtube'}
                  <span class="h-[30px] w-[52px] rounded-[5px] border-2 border-current {skin.icon}"
                  ></span>
                {:else if p.id === '4k'}
                  <span class="h-[30px] w-[52px] rounded-[5px] border-2 border-current {skin.icon}"
                  ></span>
                {:else}
                  <span
                    class="grid h-[30px] w-[52px] place-items-center rounded-[5px] border-2 border-dashed border-current {skin.icon}"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      class="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="m12 3 2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.4l6-.9z" />
                    </svg>
                  </span>
                {/if}
                {#if selected}
                  <span
                    class="absolute right-1.5 top-1.5 grid h-4.5 w-4.5 place-items-center rounded-full bg-nc-brand text-white shadow"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      class="h-2.5 w-2.5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="3.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m5 13 4 4L19 7" />
                    </svg>
                  </span>
                {/if}
              </span>
              <span class="min-w-0">
                <span class="block truncate text-[13px] font-bold leading-tight text-nc-txt"
                  >{p.label}</span
                >
                <span
                  class="mt-0.5 block truncate font-mono text-[10.5px] leading-tight {selected
                    ? skin.icon
                    : 'text-nc-mut'}">{p.note}</span
                >
              </span>
            </button>
          {/each}
        </div>

        <!-- setting rows -->
        <div class="space-y-3">
          <ExportSelect
            label="Format"
            value={format}
            display={formatText}
            soon={false}
            icon={formatIcon}
            tint="bg-nc-brand/12 text-nc-brand"
            options={FORMATS.map((f) => ({
              value: f.id,
              label: f.label,
              note: `.${f.ext} · ${f.note}`,
              disabled: multiClip && f.id !== 'video'
            }))}
            onselect={(v: string) => (format = v as ExportFormat)}
          />
          <ExportSelect
            label="Container"
            value={containerChoice}
            display={containerChoice.toUpperCase()}
            soon={!caps.container}
            disabled={format !== 'video'}
            icon={monitorIcon}
            tint="bg-nc-green/14 text-nc-green"
            options={CONTAINERS.map((c) => ({
              value: c.id,
              label: c.label,
              note: `.${c.ext} · ${c.note}`
            }))}
            onselect={(v: string) => (containerChoice = v)}
          />
          <ExportSelect
            label="Resolution"
            value={resolution}
            display={resolutionText}
            icon={monitorIcon}
            tint="bg-[#7b5cff]/14 text-[#9b8cff]"
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
            tint="bg-nc-amber/12 text-nc-amber"
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
            class="nc-hover-lift flex items-center gap-3.5 rounded-2xl border border-nc-line/80 bg-nc-panel/80 px-3.5 py-3 transition-all duration-150 hover:border-nc-line-2 hover:shadow-lg hover:shadow-black/25"
          >
            <span
              class="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/5 bg-nc-green/12 text-nc-green"
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 24 24"
                class="h-4.5 w-4.5"
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
              <span
                class="block text-[10.5px] font-semibold uppercase tracking-wider leading-tight text-nc-mut"
                >Include Audio</span
              >
              <span class="mt-0.5 block text-[14px] font-semibold leading-tight text-nc-txt">
                {includeAudio ? 'On' : 'Off'}
              </span>
            </span>
            {#if !caps.includeAudio && !includeAudio}
              <span
                class="rounded-md border border-nc-amber/30 bg-nc-amber/12 px-1.5 py-0.5 text-[9px] font-bold text-nc-amber"
                title="Backend update (EXPORT.md B1-2) ke baad apply hoga">SOON</span
              >
            {/if}
            <button
              type="button"
              role="switch"
              aria-checked={includeAudio}
              aria-label="Include Audio"
              onclick={() => (includeAudio = !includeAudio)}
              class="relative h-6.5 w-12 shrink-0 rounded-full transition-colors duration-200 {includeAudio
                ? 'bg-gradient-to-r from-nc-green to-[#2fb877] shadow-[0_0_14px_-2px_#3dd68c]'
                : 'bg-nc-panel-2'}"
            >
              <span
                class="absolute top-0.5 h-5.5 w-5.5 rounded-full bg-white shadow transition-transform duration-200 {includeAudio
                  ? 'translate-x-6'
                  : 'translate-x-0.5'}"
              ></span>
            </button>
          </div>
        </div>

        {#if showExtra}
          <div class="space-y-4">
            {#if format === 'video'}
              <section
                class="rounded-2xl border border-nc-line/80 bg-nc-panel/80 p-4 shadow-[0_10px_30px_-24px_rgba(0,0,0,0.9)]"
              >
                <h3
                  class="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-nc-mut"
                >
                  <span class="h-3 w-1 rounded-full bg-nc-brand"></span>
                  Speed · Quality
                </h3>
                <div class="grid grid-cols-2 gap-2.5">
                  {#each PRESETS as p (p.id)}
                    <button
                      type="button"
                      onclick={() => {
                        engine = p.engine;
                        quality = p.quality;
                      }}
                      aria-pressed={activePreset === p.id}
                      class="rounded-xl border px-3.5 py-3 text-left transition-all duration-150
                             {activePreset === p.id
                        ? 'border-nc-brand/70 bg-nc-brand/8 shadow-[0_0_24px_-10px_rgba(77,141,255,0.9)]'
                        : 'border-nc-line/80 bg-nc-panel-2/60 hover:border-nc-line-2'}"
                    >
                      <span class="block text-[12.5px] font-bold">{p.label}</span>
                      <span class="mt-1 block text-[10.5px] leading-snug text-nc-mut">{p.note}</span
                      >
                    </button>
                  {/each}
                </div>
                {#if estimated > 0}
                  <p class="mt-2.5 font-mono text-[10.5px] text-nc-mut-2">
                    ≈ {fmtSize(estimated)}
                  </p>
                {/if}
                <details
                  class="mt-3 rounded-xl border border-nc-line/70 bg-nc-panel-2/40 px-3.5 py-2.5"
                >
                  <summary
                    class="cursor-pointer select-none text-[11.5px] font-medium text-nc-mut transition-colors hover:text-nc-txt"
                  >
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

              <section
                class="rounded-2xl border border-nc-line/80 bg-nc-panel/80 p-4 shadow-[0_10px_30px_-24px_rgba(0,0,0,0.9)]"
              >
                <div class="flex items-center justify-between gap-2">
                  <h3
                    class="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-nc-mut"
                  >
                    <span class="h-3 w-1 rounded-full bg-[#7b5cff]"></span>
                    Codec &amp; Rate Control
                  </h3>
                  <span
                    class="rounded bg-nc-brand/15 px-1.5 py-0.5 text-[9px] font-bold text-nc-brand"
                    >RECOMMENDED</span
                  >
                </div>
                <p class="mt-1 text-[10px] text-nc-mut-2">
                  App ne best quality/settings choose ki hain. User chahe to yahan se badal sakta
                  hai.
                </p>
                <div class="mt-3 grid gap-3 sm:grid-cols-2">
                  <label class="block rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2">
                    <span class="text-[10px] text-nc-mut">Codec</span>
                    <select
                      bind:value={codecChoice}
                      class="mt-0.5 w-full bg-transparent text-xs font-semibold text-nc-txt outline-none"
                    >
                      <option value="source">Source family</option>
                      <option value="h264">H.264 — best compatibility</option>
                      <option value="h265">H.265 — smaller file</option>
                      <option value="av1">AV1 — newest</option>
                    </select>
                  </label>
                  <label class="block rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2">
                    <span class="text-[10px] text-nc-mut">CRF (quality)</span>
                    <input
                      type="number"
                      min="0"
                      max="51"
                      bind:value={crf}
                      class="mt-0.5 w-full bg-transparent text-xs font-semibold text-nc-txt outline-none"
                    />
                  </label>
                  <label
                    class="flex items-center gap-2 rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2 text-xs text-nc-txt"
                  >
                    <input type="checkbox" bind:checked={twoPass} class="accent-nc-brand" />
                    2-pass encoding
                  </label>
                  <label
                    class="flex items-center gap-2 rounded-lg border border-nc-line bg-nc-panel-2 px-3 py-2 text-xs text-nc-txt"
                  >
                    <input type="checkbox" bind:checked={includeAudio} class="accent-nc-brand" />
                    Include audio
                  </label>
                </div>
              </section>
            {/if}

            {#if format === 'gif'}
              <section
                class="rounded-2xl border border-nc-line/80 bg-nc-panel/80 p-4 shadow-[0_10px_30px_-24px_rgba(0,0,0,0.9)]"
              >
                <h3
                  class="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-nc-mut"
                >
                  <span class="h-3 w-1 rounded-full bg-nc-green"></span>
                  GIF
                </h3>
                <div class="rounded-lg border border-nc-line bg-nc-panel-2 p-3">
                  <p class="text-[11px] text-nc-mut">
                    {GIF_FPS} fps · {GIF_WIDTH} px wide · looping · palette-optimised
                  </p>
                  <p class="mt-1 text-[10px] text-nc-mut-2">
                    GIF sirf {GIF_MAX_SECS} second tak ke clip ke liye hai.
                  </p>
                  {#if gifTooLong}
                    <p class="mt-2 text-[10px] text-nc-red">
                      · Ye cut {fmtHuman(project.keptSec)} ka hai — GIF nahi ban sakta. Video, MP3 ya
                      WAV chuna lo.
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

            {#if format === 'mp3' || format === 'wav'}
              <section
                class="rounded-2xl border border-nc-line/80 bg-nc-panel/80 p-4 shadow-[0_10px_30px_-24px_rgba(0,0,0,0.9)]"
              >
                <h3
                  class="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-nc-mut"
                >
                  <span class="h-3 w-1 rounded-full bg-nc-amber"></span>
                  {format === 'wav' ? 'Audio only · WAV (lossless)' : 'Audio only · MP3'}
                </h3>
                <div class="rounded-lg border border-nc-line bg-nc-panel-2 p-3">
                  <p class="text-[11px] text-nc-mut">
                    {format === 'wav'
                      ? 'Bina compression ke 16-bit PCM — editing aur archive ke liye best.'
                      : 'Music, AI voiceover, recording ya video ka dialogue — ek MP3, bilkul nahi picture.'}
                  </p>
                </div>
                {#if format === 'mp3'}
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
                {/if}
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

            <section
              class="rounded-2xl border border-nc-line/80 bg-nc-panel/80 p-4 shadow-[0_10px_30px_-24px_rgba(0,0,0,0.9)]"
            >
              <h3
                class="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-nc-mut"
              >
                <span class="h-3 w-1 rounded-full bg-nc-brand"></span>
                Output
              </h3>
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
              <section
                class="rounded-2xl border border-nc-line/80 bg-nc-panel/80 p-4 shadow-[0_10px_30px_-24px_rgba(0,0,0,0.9)]"
              >
                <div class="flex items-center justify-between gap-2">
                  <h3
                    class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-nc-mut"
                  >
                    <span class="h-3 w-1 rounded-full bg-nc-mut"></span>
                    Export Log
                  </h3>
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
          class="nc-hover-lift flex items-center gap-3.5 rounded-2xl border border-nc-line/80 bg-nc-panel/80 px-3.5 py-3 transition-all duration-150 hover:border-nc-line-2 hover:shadow-lg hover:shadow-black/25"
        >
          <span
            class="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/5 bg-nc-amber/12 text-nc-amber"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-4.5 w-4.5"
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
            <p
              class="text-[10.5px] font-semibold uppercase tracking-wider leading-tight text-nc-mut"
            >
              Output Location
            </p>
            <p
              class="mt-0.5 truncate font-mono text-[12.5px] leading-tight text-nc-txt"
              title={output || defaultOutputPath()}
            >
              {output || defaultOutputPath()}
            </p>
          </div>
          <button
            type="button"
            onclick={chooseOutput}
            class="shrink-0 rounded-lg border border-nc-line bg-nc-panel-2 px-3.5 py-2 text-[11.5px] font-semibold text-nc-mut transition-colors hover:border-nc-brand/50 hover:text-nc-txt"
          >
            Change
          </button>
        </div>

        {#if tab === 'quick' && !moreOpen}
          <button
            type="button"
            onclick={() => (moreOpen = true)}
            class="mx-auto flex items-center gap-2 rounded-full border border-dashed border-nc-line-2/70 bg-nc-panel/50 px-4 py-2 text-[12px] font-semibold text-nc-mut transition-colors hover:border-nc-brand/60 hover:bg-nc-brand/8 hover:text-nc-txt"
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
        <!-- preview card: a cinema screen with a spec HUD -->
        <div
          class="group relative overflow-hidden rounded-2xl border border-nc-line/80 bg-nc-panel/80 shadow-[0_20px_50px_-30px_rgba(0,0,0,0.9)]"
        >
          <div class="relative w-full bg-black" style="aspect-ratio: {previewAspect}">
            {#if poster}
              <img
                src={poster}
                alt="preview"
                class="h-full w-full object-cover opacity-90 transition-transform duration-500 group-hover:scale-[1.03]"
              />
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
            <!-- top scrim + resolution badge -->
            <div
              class="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/70 to-transparent p-3"
            >
              <span
                class="rounded-md border border-white/15 bg-black/45 px-2 py-1 font-mono text-[10px] font-bold tracking-wide text-white backdrop-blur"
              >
                {frame && frame.width > 0 ? `${frame.width} × ${frame.height}` : resolutionText}
              </span>
              <span
                class="rounded-md border border-white/15 bg-black/45 px-2 py-1 font-mono text-[10px] font-bold tracking-wide text-white backdrop-blur"
              >
                {frameRateText}
              </span>
            </div>
            <!-- bottom scrim + timeline chip -->
            <div
              class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/80 to-transparent p-3"
            >
              <span class="font-mono text-[10px] font-medium text-white/85">
                ▸ {fmtHuman(finalSecs)} final
              </span>
              <span
                class="font-mono text-[10px] font-medium uppercase tracking-wider text-white/60"
              >
                {formatText}
              </span>
            </div>
            <button
              type="button"
              onclick={async () => {
                if (project.sourcePath) await openPath(project.sourcePath);
              }}
              class="absolute left-1/2 top-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/25 bg-white/12 text-white backdrop-blur-md transition-all duration-200 hover:scale-110 hover:bg-white/25"
              title="Source kholo"
              aria-label="Play source"
            >
              <svg
                viewBox="0 0 24 24"
                class="h-7 w-7 translate-x-0.5"
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
          <div
            class="relative overflow-hidden rounded-2xl border border-nc-amber/45 bg-nc-amber/[0.07] p-4"
          >
            <div
              class="pointer-events-none absolute -right-14 -top-14 h-36 w-36 rounded-full bg-nc-amber/20 blur-3xl"
              aria-hidden="true"
            ></div>
            <div class="relative flex items-center gap-3">
              <span
                class="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/5 bg-nc-amber/15 text-nc-amber"
              >
                <svg
                  viewBox="0 0 24 24"
                  class="h-5 w-5"
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
                <p class="text-[13px] font-extrabold tracking-tight text-nc-amber">
                  File already exists
                </p>
                <p class="truncate font-mono text-[11px] text-nc-mut" title={output}>
                  {output.split(/[\\/]/).pop()}
                </p>
              </div>
            </div>
            <div class="relative mt-3.5 flex gap-2">
              <button
                type="button"
                onclick={() => {
                  overwriteArmed = true;
                  run(true);
                }}
                class="flex-1 rounded-xl bg-gradient-to-r from-nc-amber to-[#c98f36] py-3 text-[12.5px] font-bold text-nc-bg shadow-[0_10px_24px_-14px_rgba(224,169,79,0.9)] transition hover:brightness-110"
                >Overwrite &amp; Export</button
              >
              <button
                type="button"
                onclick={() => {
                  preflight = null;
                  chooseOutput();
                }}
                class="rounded-xl border border-nc-line/80 bg-nc-panel/70 px-4 py-3 text-[12.5px] font-semibold text-nc-mut transition-colors hover:border-nc-brand/50 hover:text-nc-txt"
                >Change location</button
              >
            </div>
          </div>
        {:else if running}
          <div
            class="relative overflow-hidden rounded-2xl border border-nc-brand/40 bg-nc-brand/[0.06] p-4"
          >
            <div
              class="pointer-events-none absolute -left-16 -top-16 h-40 w-40 rounded-full bg-nc-brand/25 blur-3xl"
              aria-hidden="true"
            ></div>
            <div class="relative flex items-center gap-3">
              <span
                class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-nc-brand/15 text-nc-brand"
              >
                <svg
                  viewBox="0 0 24 24"
                  class="h-4.5 w-4.5 animate-spin"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M12 2a10 10 0 0 1 10 10" />
                </svg>
              </span>
              <div class="min-w-0 flex-1">
                <p class="text-[13px] font-extrabold tracking-tight text-nc-brand">
                  {stageLabel(stage) || 'Working'}
                </p>
                <p class="truncate text-[11px] text-nc-mut">{message || 'Export chal raha hai…'}</p>
              </div>
              <span class="font-mono text-2xl font-extrabold tabular-nums text-nc-txt"
                >{percent.toFixed(0)}<span class="text-sm text-nc-mut">%</span></span
              >
            </div>
            <div
              class="relative mt-3 h-2.5 overflow-hidden rounded-full border border-white/5 bg-black/30"
            >
              <div
                class="nc-bar h-full rounded-full bg-gradient-to-r from-nc-brand via-[#6a5cff] to-[#9b5cff] transition-[width] duration-300 ease-out"
                style="width:{percent}%"
              ></div>
            </div>
            <div
              class="relative mt-2.5 flex items-center justify-between font-mono text-[10.5px] text-nc-mut"
            >
              <span class="rounded border border-nc-line/70 bg-black/25 px-1.5 py-0.5"
                >piece {pieceIndex || 1}/{pieceCount || 1}</span
              >
              <span
                >{fmtClock(elapsedSecs)} elapsed{eta !== null
                  ? ` · ${fmtClock(eta)} left`
                  : ''}</span
              >
            </div>
            {#if speedX > 0}
              <p class="relative mt-1.5 font-mono text-[10px] text-nc-mut-2">
                ⚡ {fmtRate(speedX)} realtime
              </p>
            {/if}
            <button
              type="button"
              onclick={armCancel}
              class="relative mt-3 w-full rounded-lg border py-2 text-[11.5px] font-semibold transition-colors
                     {cancelArmed
                ? 'animate-pulse border-nc-red bg-nc-red/15 text-nc-red'
                : 'border-nc-line/80 bg-black/20 text-nc-mut hover:border-nc-red/50 hover:text-nc-red'}"
            >
              {cancelArmed ? 'Confirm cancel? (3s)' : 'Cancel'}
            </button>
          </div>
        {:else if result}
          <div
            class="nc-tie-edge relative overflow-hidden rounded-2xl border border-nc-green/40 bg-nc-green/[0.07] p-4 text-center"
          >
            <div
              class="pointer-events-none absolute -right-14 -top-14 h-36 w-36 rounded-full bg-nc-green/20 blur-3xl"
              aria-hidden="true"
            ></div>
            <span
              class="mx-auto grid h-14 w-14 place-items-center rounded-full border border-nc-green/40 bg-nc-green/15 text-nc-green"
            >
              <svg
                viewBox="0 0 24 24"
                class="h-7 w-7"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m5 13 4 4L19 7" />
              </svg>
            </span>
            <p class="mt-2.5 text-base font-extrabold tracking-tight text-nc-green">
              Export complete
            </p>
            <p class="mt-1 font-mono text-[11px] text-nc-mut">
              {result.pieceCount} piece{result.pieceCount === 1 ? '' : 's'} · {fmtSize(
                result.sizeBytes
              )} · {fmtHuman(result.durationSecs)}
            </p>
            {#if result.encoder}
              <p class="mt-1 font-mono text-[10px] text-nc-mut-2">encoder: {result.encoder}</p>
            {/if}
            <p class="mt-1 break-all font-mono text-[10px] text-nc-mut-2">{result.output}</p>
            {#if warnings.length}
              <ul
                class="mt-2 space-y-1 rounded-lg border border-nc-red/30 bg-nc-red/8 p-2 text-left text-[10px] text-nc-red"
              >
                {#each warnings as w (w)}<li>· {w}</li>{/each}
              </ul>
            {/if}
            <div class="mt-3.5 flex gap-2">
              <button
                type="button"
                onclick={openResult}
                class="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-nc-green to-[#2fb877] py-3 text-[12.5px] font-bold text-nc-bg transition hover:brightness-110"
                >▶ Play</button
              >
              <button
                type="button"
                onclick={showResult}
                class="flex-1 rounded-xl border border-nc-line/80 bg-nc-panel/70 py-3 text-[12.5px] font-semibold text-nc-mut transition-colors hover:border-nc-brand/50 hover:text-nc-txt"
                >Show in folder</button
              >
            </div>
            <button
              type="button"
              onclick={resetResult}
              class="mt-2.5 text-[11px] text-nc-mut-2 underline-offset-2 hover:text-nc-txt hover:underline"
              >Export again</button
            >
          </div>
        {:else}
          <!-- hero card: the one thing on this screen that should feel like a launch button -->
          <div
            class="nc-ready relative overflow-hidden rounded-2xl border border-nc-brand/30 bg-gradient-to-b from-nc-brand/[0.09] to-transparent p-4"
          >
            <div
              class="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full bg-nc-brand/25 blur-3xl"
              aria-hidden="true"
            ></div>
            <div class="relative flex items-center gap-3.5">
              <span
                class="nc-pulse grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-nc-brand to-[#7b5cff] text-white shadow-[0_8px_24px_-8px_rgba(77,141,255,0.9)]"
              >
                <svg
                  viewBox="0 0 24 24"
                  class="h-6 w-6"
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
                <p class="text-[15px] font-extrabold tracking-tight text-nc-txt">Ready to Export</p>
                <p class="mt-0.5 text-[11.5px] text-nc-mut">
                  Estimated file size
                  <span class="font-mono font-bold text-nc-brand"
                    >~ {fmtSize(estimated) || '—'}</span
                  >
                </p>
              </div>
            </div>

            <!-- spec strip: what you are about to render, in one glance -->
            <div class="relative mt-3.5 flex flex-wrap gap-1.5">
              <span
                class="nc-chip rounded-md border border-nc-line/80 bg-nc-panel-2/70 px-2 py-1 font-mono text-[10px] font-medium text-nc-mut"
                >{resolutionText}</span
              >
              <span
                class="nc-chip rounded-md border border-nc-line/80 bg-nc-panel-2/70 px-2 py-1 font-mono text-[10px] font-medium text-nc-mut"
                >{frameRateText}</span
              >
              <span
                class="nc-chip rounded-md border border-nc-line/80 bg-nc-panel-2/70 px-2 py-1 font-mono text-[10px] font-medium uppercase text-nc-mut"
                >{formatText}</span
              >
              {#if format === 'video'}
                <span
                  class="nc-chip rounded-md border border-nc-line/80 bg-nc-panel-2/70 px-2 py-1 font-mono text-[10px] font-medium text-nc-mut"
                  >{includeAudio ? 'audio on' : 'no audio'}</span
                >
              {/if}
            </div>

            {#if !canRun}
              <p
                class="relative mt-3 rounded-lg border border-nc-line/60 bg-nc-panel/60 px-3 py-2 text-[11px] leading-relaxed text-nc-mut-2"
              >
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
              class="nc-cta group/cta relative mt-3.5 flex w-full items-center justify-center gap-2.5 overflow-hidden rounded-xl bg-gradient-to-r from-nc-brand via-[#5f7bff] to-[#7b5cff] py-4 text-[14px] font-extrabold tracking-wide text-white shadow-[0_12px_32px_-12px_rgba(77,141,255,0.9)] transition-all duration-200 hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0 disabled:opacity-40 disabled:shadow-none disabled:hover:translate-y-0"
            >
              <span
                class="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 group-hover/cta:translate-x-full"
                aria-hidden="true"
              ></span>
              <svg
                viewBox="0 0 24 24"
                class="h-4.5 w-4.5"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
              Export Video
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
