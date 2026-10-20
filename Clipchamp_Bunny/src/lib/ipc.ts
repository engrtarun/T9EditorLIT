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
 * Measure real download throughput.
 *
 * The trick that makes this honest: the clock starts when the **first body
 * byte** arrives, not when `fetch` was called. Otherwise DNS + TCP + TLS +
 * TTFB get divided into the transfer time, and a fast link reads as slow —
 * a 40 Mbps line was showing as 2 MB/s for exactly this reason.
 *
 * It also keeps fetching for a fixed window so one slow burst cannot decide
 * the number, and reports MB/s **and** Mbps — the unit a browser shows.
 */
export async function measureNetworkSpeed(
  windowMs = 3000
): Promise<{ mbps: number; megabytesPerSec: number } | null> {
  // Prefer the Go daemon: parallel sockets + tuned receive buffers give an
  // honest reading on fast links (single-socket fetch() under-reads). Fall
  // back to the in-webview probe when the daemon is unreachable (browser dev
  // mode, or daemon down) so the meter never goes blank.
  try {
    const res = await fetch(`http://127.0.0.1:7878/v1/net/speed?windowMs=${windowMs}`, {
      cache: 'no-store'
    });
    if (res.ok) {
      const data = (await res.json()) as { mbps?: number; megabytesPerSec?: number };
      if (typeof data?.megabytesPerSec === 'number') {
        return { mbps: data.mbps ?? 0, megabytesPerSec: data.megabytesPerSec };
      }
    }
  } catch {
    /* daemon not reachable - fall through */
  }

  const endpoint = 'https://speed.cloudflare.com/__down?bytes=8000000';
  let bytes = 0;
  let elapsed = 0;

  try {
    const deadline = performance.now() + windowMs;
    do {
      const res = await fetch(endpoint, { cache: 'no-store' });
      if (!res.ok || !res.body) return null;
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
