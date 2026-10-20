/**
 * The single place that talks to Rust.
 *
 * Every `invoke` call goes through a named wrapper here, so command names and
 * payload shapes are validated in one spot instead of being scattered across
 * components as raw strings.
 *
 * The app runs in two modes:
 *   • **Tauri** — real Rust commands, real FFmpeg, real SQLite.
 *   • **Browser** (`npm run dev` on localhost) — falls back to the media baked
 *     by `tools/generate-media.mjs`, so the UI can be developed and tested
 *     without a Rust toolchain.
 */

import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import type {
  AudioChunk,
  MemoryStats,
  MediaInfo,
  SilenceRange,
  SystemDetails,
  SystemSnapshot,
  ThumbnailStrip,
  WaveformData
} from './types';

/** True when we are inside a Tauri webview. */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Turn a filesystem path into a URL the webview can stream from. */
export function assetUrl(path: string): string {
  return isTauri() ? convertFileSrc(path) : path;
}

/** Path of the bundled demo source, if it can be found. */
export function demoSourcePath(): Promise<string | null> {
  return invoke<string | null>('demo_source_path');
}

/**
 * The one spelling of a path that always identifies the same file.
 *
 * The transcript table is keyed by path, so the *string* has to be stable. A
 * path built from the working directory spells itself differently depending
 * on where the app was launched from — which is how the taskbar launch missed
 * the cache and re-transcribed the video.
 */
export function canonicalSourcePath(path: string): Promise<string> {
  return invoke<string>('canonical_source_path', { path });
}

/** Open the native file picker and return the chosen path. */
export async function pickVideo(): Promise<string | null> {
  if (!isTauri()) return null;
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] }]
  });
  return typeof picked === 'string' ? picked : null;
}

/** Open the native file picker for **several** files at once. */
export async function pickVideos(): Promise<string[]> {
  if (!isTauri()) return [];
  const picked = await open({
    multiple: true,
    directory: false,
    filters: [
      { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] },
      { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac'] }
    ]
  });
  if (Array.isArray(picked)) return picked;
  return typeof picked === 'string' ? [picked] : [];
}

/** Is `yt-dlp` available for link imports? */
export function checkYtDlp(): Promise<boolean> {
  return invoke<boolean>('check_yt_dlp');
}

/**
 * Download a video from a URL (YouTube and friends) with `yt-dlp`.
 * The bytes stream straight to disk — they never touch this process's heap.
 */
export function downloadFromUrl(url: string): Promise<string> {
  return invoke<string>('download_from_url', { url });
}

/** Set by the project store once a real file is loaded. */
let currentSourcePath: string | null = null;
export function setSourcePath(path: string | null) {
  currentSourcePath = path;
}

/** Reveal the current source in Explorer — Clipchamp's "Open file location". */
export async function revealSource(): Promise<boolean> {
  const path = currentSourcePath;
  if (!path || !isTauri()) return false;
  try {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    revealItemInDir(path);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ media */

/** Inspect a media file via ffprobe. Cached in SQLite by path + size + mtime. */
export function probeMedia(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>('probe_media', { path });
}

/** Waveform peaks for the timeline, cached as JSON on disk. */
export function extractWaveform(
  path: string,
  outDir?: string,
  bars?: number
): Promise<WaveformData> {
  return invoke<WaveformData>('extract_waveform', { path, outDir, bars });
}

/** ~1 fps JPEG filmstrip for the video lane. */
export function extractThumbnails(
  path: string,
  outDir?: string,
  fps?: number,
  width?: number
): Promise<ThumbnailStrip> {
  return invoke<ThumbnailStrip>('extract_thumbnails', { path, outDir, fps, width });
}

/** Which hardware encoders this box can use (QuickSync / NVENC / AMF). */
export function detectHardware(): Promise<{
  qsv: boolean;
  nvenc: boolean;
  amf: boolean;
  detail: string;
}> {
  return invoke('detect_hardware');
}

/** Liveness check so the UI can say "FFmpeg not found" instead of failing. */
export function checkFfmpeg(): Promise<string> {
  return invoke<string>('check_ffmpeg');
}

/** Extract mono 16 kHz audio into ~segmentSecs WAV chunks. */
export function extractAudioChunks(
  path: string,
  outDir?: string,
  segmentSecs?: number
): Promise<AudioChunk[]> {
  return invoke<AudioChunk[]>('extract_audio_chunks', { path, outDir, segmentSecs });
}

/**
 * Detect silent spans (dead air) with FFmpeg's `silencedetect` filter.
 * `noiseDb` is the RMS threshold, `minSecs` the floor on what counts as
 * silence. Clipchamp's AI auto-cut uses ~3 s.
 */
export function detectSilence(
  path: string,
  noiseDb?: number,
  minSecs?: number
): Promise<SilenceRange[]> {
  return invoke<SilenceRange[]>('detect_silence', { path, noiseDb, minSecs });
}

/* ------------------------------------------------------------- transcript */

export function defaultDbPath(): Promise<string> {
  return invoke<string>('default_db_path');
}

export interface RustWord {
  word: string;
  start: number;
  end: number;
}

export interface RustTranscriptLine {
  id: string;
  startSecs: number;
  endSecs: number;
  text: string;
  keep: boolean;
  flag: string;
  originalText: string;
  words?: RustWord[];
}

export function loadTranscript(dbPath: string, sourcePath: string): Promise<RustTranscriptLine[]> {
  return invoke('load_transcript', { dbPath, sourcePath });
}

export function saveTranscript(
  dbPath: string,
  sourcePath: string,
  lines: unknown[]
): Promise<void> {
  return invoke('save_transcript', { dbPath, sourcePath, lines });
}

export function setTranscriptKeep(
  dbPath: string,
  sourcePath: string,
  id: string,
  keep: boolean
): Promise<void> {
  return invoke('set_transcript_keep', { dbPath, sourcePath, id, keep });
}

/* ---------------------------------------------------------------- projects */

export interface RustProject {
  id: string;
  name: string;
  sourcePath: string;
  durationSecs: number;
  lastOpened: number;
}

/**
 * The source path of the project that was opened last, if its file is still
 * on disk.
 *
 * This is what the app opens on start-up: the user's own video, with the
 * transcript that is already in SQLite. No API call, no mock lines.
 */
export function resumeProject(dbPath: string): Promise<string | null> {
  return invoke<string | null>('resume_project', { dbPath });
}

/** Remember a project so it can be reopened later. */
export function saveProject(
  dbPath: string,
  id: string,
  name: string,
  sourcePath: string,
  durationSecs: number,
  lastOpened: number
): Promise<void> {
  return invoke('save_project', {
    dbPath,
    id,
    name,
    sourcePath,
    durationSecs,
    lastOpened
  });
}

/** Every known project, most recently opened first. */
export function loadProjects(dbPath: string): Promise<RustProject[]> {
  return invoke<RustProject[]>('load_projects', { dbPath });
}

/** Mark a project as opened now (updates its position in the list). */
export function updateProjectOpened(
  dbPath: string,
  sourcePath: string,
  lastOpened: number
): Promise<void> {
  return invoke('update_project_opened', { dbPath, sourcePath, lastOpened });
}

/* ------------------------------------------------------------------- trash */

/** A project the user removed from the list. The video file is untouched. */
export interface RustTrashItem {
  id: string;
  name: string;
  sourcePath: string;
  durationSecs: number;
  /** Unix seconds — when the project was moved to the bin. */
  deletedAt: number;
}

/** Move a project out of the list and into the bin. */
export function trashProject(dbPath: string, sourcePath: string): Promise<void> {
  return invoke('trash_project', { dbPath, sourcePath });
}

/** Bring a project back from the bin. */
export function restoreProject(dbPath: string, sourcePath: string): Promise<void> {
  return invoke('restore_project', { dbPath, sourcePath });
}

/** Everything currently in the bin, newest first. */
export function loadTrash(dbPath: string): Promise<RustTrashItem[]> {
  return invoke<RustTrashItem[]>('load_trash', { dbPath });
}

/** Forget a binned project for good — the app's record only, never the file. */
export function purgeTrash(dbPath: string, sourcePath: string): Promise<void> {
  return invoke('purge_trash', { dbPath, sourcePath });
}

/* ------------------------------------------------------------------ poster */

/** One poster frame for a dashboard card. */
export interface RustPoster {
  /** Absolute path of the cached JPEG on disk. */
  path: string;
  width: number;
  height: number;
  /** True when the frame was already on disk — no FFmpeg was started. */
  cached: boolean;
}

/**
 * Extract **one** frame from a source, for the dashboard's project cards.
 *
 * Not `extractThumbnails`: that samples the whole video at 1 fps, which means
 * decoding two hours of footage to fill a strip. A card needs a single still,
 * so this seeks straight to it and grabs one frame. The JPEG is cached on
 * disk, keyed by the source's path + size + mtime.
 */
export function extractPoster(path: string, atSecs?: number, width?: number): Promise<RustPoster> {
  return invoke<RustPoster>('extract_poster', { path, atSecs, width });
}

/* ------------------------------------------------------------------ system */

/** How much room is left on the drive that holds the app's data. */
export interface RustDriveSpace {
  /** The drive's mount point, e.g. `C:\`. */
  drive: string;
  totalBytes: number;
  freeBytes: number;
}

/**
 * Free space on the drive that holds the app's data folder.
 *
 * Only the disk list is read — no CPU sampling — so the dashboard can call it
 * while it is still painting.
 */
export function driveSpace(): Promise<RustDriveSpace | null> {
  return invoke<RustDriveSpace | null>('drive_space');
}

/**
 * One reading of every meter the status bar shows: RAM, drive, the app's own
 * disk usage and the network throughput.
 *
 * One call per second is enough for all of them, and it costs the app no
 * memory: the Rust side reads counters and adds up file sizes, nothing else.
 */
export function systemSnapshot(): Promise<SystemSnapshot> {
  return invoke<SystemSnapshot>('system_snapshot');
}

/**
 * Move the machine's clock (and optionally its time zone).
 *
 * Windows only lets a privileged process do this, so it can fail — the real
 * reason comes back as the error message.
 */
export function setSystemClock(timeZone: string | null, utcIso: string): Promise<string> {
  return invoke('set_system_clock', { timeZone, utcIso });
}

/**
 * Reveal any path in Explorer.
 *
 * `revealSource` is the "current project" shortcut; this one is what the
 * dashboard's project menu needs, where there is no current project yet.
 */
export async function revealPath(path: string): Promise<boolean> {
  if (!path || !isTauri()) return false;
  try {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    revealItemInDir(path);
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- system */

/** Live RAM reading for the top-bar meter. */
export function getMemoryStats(): Promise<MemoryStats> {
  return invoke<MemoryStats>('get_memory_stats');
}

/** Full machine snapshot for the "PC details" popover. */
export function systemDetails(): Promise<SystemDetails> {
  return invoke<SystemDetails>('system_details');
}

/* ------------------------------------------------------------------ export */

export interface ExportSegment {
  start: number;
  end: number;
}

export interface ExportOptions {
  /** `hybrid` (default) · `copy` (snap to keyframes, never encode) · `encode`. */
  mode: string;
  alignToleranceMs: number;
  /** `original` · `high` · `balanced` · `small`. */
  quality: string;
}

export interface ExportRequest {
  source: string;
  segments: ExportSegment[];
  output: string;
  options: ExportOptions;
  dbPath: string | null;
}

export interface ExportResult {
  output: string;
  durationSecs: number;
  sizeBytes: number;
  pieceCount: number;
  encoder: string | null;
  warnings: string[];
}

export interface ExportProgress {
  stage: 'scan' | 'cut' | 'concat' | 'done' | string;
  pieceIndex: number;
  pieceCount: number;
  percent: number;
  message: string;
}

export function startExport(request: ExportRequest): Promise<ExportResult> {
  return invoke<ExportResult>('start_export', { request });
}

export function cancelExport(): Promise<void> {
  return invoke('cancel_export');
}

export function planExport(request: ExportRequest): Promise<{
  durationSecs: number;
  estimatedBytes: number;
  pieceCount: number;
  warnings: string[];
}> {
  return invoke('plan_export', { request });
}

export function onExportProgress(cb: (p: ExportProgress) => void): Promise<() => void> {
  return listen<ExportProgress>('export-progress', (e) => cb(e.payload));
}

/** Native "save as" dialog for the rendered file. */
export async function pickOutput(defaultName: string): Promise<string | null> {
  if (!isTauri()) return null;
  const picked = await save({
    defaultPath: defaultName,
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
  });
  return picked ?? null;
}

/* ------------------------------------------------------------------ network */

/**
 * The build sitting in the install folder.
 *
 * `builtAt` changes when a newer build is installed, and `updateReady` is
 * true when that newer build is staged and only a restart is needed.
 */
export function installedBuild(): Promise<{
  builtAt: string;
  version: string;
  buildId: string;
  runningBuildId: string;
  updateReady: boolean;
} | null> {
  return invoke<{
    builtAt: string;
    version: string;
    buildId: string;
    runningBuildId: string;
    updateReady: boolean;
  } | null>('installed_build');
}

/** Swap the staged build in and relaunch the app. */
export function applyStagedUpdate(): Promise<void> {
  return invoke('apply_staged_update');
}

/**
 * The cloud daemon's health report, straight from the daemon.
 *
 * `null` means the daemon is not running. The `cloud` object carries the real
 * per-provider capability strings (`"ready"`, or the reason it is not).
 */
export function daemonHealth(): Promise<{
  ok?: boolean;
  uptime_secs?: number;
  cloud?: Record<string, string>;
} | null> {
  return invoke<{
    ok?: boolean;
    uptime_secs?: number;
    cloud?: Record<string, string>;
  } | null>('daemon_health');
}

/**
 * Dashboard greeting lines (Hinglish + English).
 *
 * The daemon owns the Groq call and its cache, so repeated app launches inside
 * its TTL cost nothing. `null` means the daemon is not running (or this is the
 * browser preview) — the dashboard keeps its local bank line.
 */
export function greetingLines(): Promise<{
  en: string;
  hi: string;
  generatedAt: string;
  source: 'groq' | 'bank';
  cached: boolean;
} | null> {
  if (!isTauri()) return Promise.resolve(null);
  return invoke<{
    en: string;
    hi: string;
    generatedAt: string;
    source: 'groq' | 'bank';
    cached: boolean;
  } | null>('greeting_lines').catch(() => null);
}

/**
 * Measure real download throughput.
 *
 * The trick that makes this honest: the clock starts when the **first body
 * byte** arrives, not when `fetch` was called. Otherwise DNS + TCP + TLS +
 * TTFB get divided into the transfer time, and a fast link reads as slow —
 * a 40 Mbps line was showing as 2 MB/s for exactly this reason.
 *
 * It also keeps fetching for a fixed window so one slow burst cannot decide
 * the number, and reports MB/s **and** Mbps — the unit a browser shows.
 *
 * On the desktop the reading comes from **Rust**, which asks the daemon over a
 * plain socket. The webview path is only the browser fallback: a browser
 * fetch to the loopback daemon can be swallowed by the webview's own network
 * rules, and the chip would sit on "—" while the daemon was answering.
 */
export async function measureNetworkSpeed(
  windowMs = 3000
): Promise<{ mbps: number; megabytesPerSec: number } | null> {
  // Every path here is on a timer, so it must never hang: a request that
  // never settles would leave the meter stuck on "measuring" and every later
  // attempt would be skipped.
  const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    try {
      return await Promise.race([promise, guard]);
    } finally {
      clearTimeout(timer);
    }
  };

  if (isTauri()) {
    // The daemon first, over the webview. The app already talks to the
    // daemon this way, so it is known to work - and it is the reading the
    // daemon actually measured, with its parallel sockets.
    try {
      const res = await withTimeout(
        fetch(`http://127.0.0.1:7878/v1/net/speed?windowMs=${windowMs}`, {
          cache: 'no-store'
        }),
        windowMs + 8000
      );
      if (res?.ok) {
        const data = (await res.json()) as { mbps?: number; megabytesPerSec?: number };
        if (typeof data?.megabytesPerSec === 'number') {
          return { mbps: data.mbps ?? 0, megabytesPerSec: data.megabytesPerSec };
        }
      }
    } catch {
      /* the daemon is not up yet - fall through */
    }

    // Then through Rust, which asks the daemon over a plain socket. No CORS,
    // no content-security policy, no webview rules in the way.
    try {
      const speed = await withTimeout(
        invoke<{ mbps: number; megabytesPerSec: number } | null>('measure_network_speed', {
          windowMs
        }),
        windowMs + 8000
      );
      if (speed && typeof speed.megabytesPerSec === 'number') {
        return speed;
      }
    } catch {
      /* no Rust command on this build - fall through */
    }
  }

  // Browser fallback: a single streaming download, timed from the first byte.
  const endpoint = 'https://speed.cloudflare.com/__down?bytes=8000000';
  let bytes = 0;
  let elapsed = 0;

  try {
    const deadline = performance.now() + windowMs;
    do {
      const res = await withTimeout(fetch(endpoint, { cache: 'no-store' }), 10000);
      if (!res?.ok || !res.body) return null;
      const reader = res.body.getReader();
      const t0 = performance.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength ?? 0;
      }
      elapsed += (performance.now() - t0) / 1000;
    } while (performance.now() < deadline);

    if (elapsed <= 0 || bytes <= 0) return null;
    const megabytesPerSec = bytes / 1_048_576 / elapsed;
    return { megabytesPerSec, mbps: megabytesPerSec * 8 };
  } catch {
    return null;
  }
}

/* ==========================================================================
 * Telemetry (SQLite via the stats writer)
 *
 * Every function here is **fire-and-forget**: logging must never slow an
 * edit, block a save, or surface an error to the user. Failures collapse
 * into a resolved promise / no-op — the Rust side itself batches into one
 * background transaction, so a call here costs a single tiny channel send.
 * ========================================================================== */

/** One diagnostic line: `warn` · `error` · `info`, a component, a message. */
export function logAppEvent(level: string, component: string, message: string): void {
  if (!isTauri()) return;
  void invoke('log_app_event', { level, component, message }).catch(() => {});
}

/** One real edit burst (autosave, rename, …) — the user-progress trail. */
export function logEditAction(project: string, action: string, payload: unknown = {}): void {
  if (!isTauri()) return;
  void invoke('log_edit_action', {
    project,
    action,
    payload: JSON.stringify(payload)
  }).catch(() => {});
}

/** One finished transcription run (`done` · `failed`), recorded with its span. */
export function logTranscriptionJob(
  sourcePath: string,
  status: string,
  provider: string,
  audioSecs: number,
  error: string,
  elapsedSecs: number
): void {
  if (!isTauri()) return;
  void invoke('log_transcription_job', {
    sourcePath,
    status,
    provider,
    audioSecs,
    error,
    elapsedSecs
  }).catch(() => {});
}

/** Read a small persisted key (flags, last options); `null` when absent. */
export function statsGet(key: string): Promise<string | null> {
  if (!isTauri()) return Promise.resolve(null);
  return invoke<string | null>('stats_kv_get', { key }).catch(() => null);
}

/** Persist a small key — on-disk, tiny, fire-and-forget friendly. */
export function statsSet(key: string, value: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke<void>('stats_kv_set', { key, value }).catch(() => {});
}
