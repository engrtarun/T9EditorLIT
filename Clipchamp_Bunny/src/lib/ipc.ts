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
import { open } from '@tauri-apps/plugin-dialog';
import type {
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

export function loadTranscript(
  dbPath: string,
  sourcePath: string
): Promise<
  Array<{
    id: string;
    startSec: number;
    endSec: number;
    text: string;
    flag: string;
    keep: boolean;
  }>
> {
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

export interface ExportRequest {
  source: string;
  output: string;
  segments: Array<{ start: number; end: number }>;
  mode: string;
  width?: number;
  height?: number;
}

export interface ExportResult {
  output: string;
  bytes: number;
  durationSecs: number;
  pieces: number;
}

export function startExport(request: ExportRequest): Promise<ExportResult> {
  return invoke<ExportResult>('start_export', { request });
}

export function cancelExport(): Promise<void> {
  return invoke('cancel_export');
}

export function onExportProgress(
  cb: (p: { stage: string; percent: number; message: string }) => void
): Promise<() => void> {
  return listen<{ stage: string; percent: number; message: string }>('export-progress', (e) =>
    cb(e.payload)
  );
}

/* ------------------------------------------------------------------ network */

/**
 * Measure real download throughput with a short burst against a public speed
 * endpoint. Returns MB/s, or null when the box is offline.
 */
export async function measureNetworkSpeed(bytes = 8_000_000): Promise<number | null> {
  try {
    const t0 = performance.now();
    const res = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`, {
      cache: 'no-store'
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const secs = (performance.now() - t0) / 1000;
    if (secs <= 0) return null;
    return buf.byteLength / 1_048_576 / secs;
  } catch {
    return null;
  }
}
