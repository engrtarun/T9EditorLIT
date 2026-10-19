/**
 * The single place that talks to Rust.
 *
 * Every `invoke` call in the app goes through a named wrapper here, so the
 * command names and payload shapes are validated in one spot instead of being
 * scattered across components as raw strings.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  AudioChunk,
  CloudJob,
  EnvEntry,
  EnvInfo,
  ExportPlan,
  ExportProgress,
  ExportRequest,
  ExportResult,
  HardwareSupport,
  LoginChallenge,
  MediaInfo,
  MemoryStats,
  PolishResult,
  PolishSettings,
  Project,
  SilenceRange,
  ThumbnailStrip,
  TranscriptLine,
  VaultProgress,
  VaultStatus,
  WaveformData,
} from "./types";

/** Live RAM reading for the top-bar meter. */
export function getMemoryStats(): Promise<MemoryStats> {
  return invoke<MemoryStats>("get_memory_stats");
}

/** Inspect a media file via ffprobe. Rejects if FFmpeg is missing. */
export function probeMedia(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("probe_media", { path });
}

/** Which hardware encoders this machine can use (QuickSync / NVENC / AMF). */
export function detectHardware(): Promise<HardwareSupport> {
  return invoke<HardwareSupport>("detect_hardware");
}

/** Extract mono 16 kHz audio into ~segmentSecs WAV chunks. */
export function extractAudioChunks(
  path: string,
  outDir?: string,
  segmentSecs?: number,
): Promise<AudioChunk[]> {
  return invoke<AudioChunk[]>("extract_audio_chunks", {
    path,
    outDir,
    segmentSecs,
  });
}

/**
 * Detect silent spans (dead air) in a source's audio.
 * `noiseDb` is the RMS threshold (dB, e.g. -30) and `minSecs` the floor on
 * what counts as silence, so short breaths are kept and the cut stays natural.
 */
export function detectSilence(
  path: string,
  noiseDb?: number,
  minSecs?: number,
): Promise<SilenceRange[]> {
  return invoke<SilenceRange[]>("detect_silence", { path, noiseDb, minSecs });
}

/** Default SQLite path for transcript/cut state. */
export function defaultDbPath(): Promise<string> {
  return invoke<string>("default_db_path");
}

/** Default directory for extracted audio chunks. */
export function defaultChunkDir(): Promise<string> {
  return invoke<string>("default_chunk_dir");
}

/** Default root of the derived-media cache (waveform JSON + thumbnails). */
export function defaultCacheDir(): Promise<string> {
  return invoke<string>("default_cache_dir");
}

/**
 * Peak amplitudes for the timeline waveform, one per time bucket, normalized
 * 0–1. Cached as JSON on disk keyed by source mtime, so a reload skips FFmpeg.
 */
export function extractWaveform(
  path: string,
  outDir?: string,
  bars?: number,
): Promise<WaveformData> {
  return invoke<WaveformData>("extract_waveform", { path, outDir, bars });
}

/**
 * Sample ~1 fps JPEG thumbnails into a per-source disk cache. Returns the
 * cache directory and frame count; file names are derived client-side.
 */
export function extractThumbnails(
  path: string,
  outDir?: string,
  fps?: number,
  width?: number,
): Promise<ThumbnailStrip> {
  return invoke<ThumbnailStrip>("extract_thumbnails", { path, outDir, fps, width });
}

/** Load transcript lines for a source video. */
export function loadTranscript(dbPath: string, sourcePath: string): Promise<TranscriptLine[]> {
  return invoke<TranscriptLine[]>("load_transcript", { dbPath, sourcePath });
}

/** Replace the stored transcript for a source video. */
export function saveTranscript(
  dbPath: string,
  sourcePath: string,
  lines: TranscriptLine[],
): Promise<void> {
  return invoke<void>("save_transcript", { dbPath, sourcePath, lines });
}

/** Flip the keep/cut decision for one transcript line. */
export function setTranscriptKeep(
  dbPath: string,
  sourcePath: string,
  id: string,
  keep: boolean,
): Promise<void> {
  return invoke<void>("set_transcript_keep", { dbPath, sourcePath, id, keep });
}

/** FFmpeg version string, or a thrown error if FFmpeg is not usable. */
export function checkFfmpeg(): Promise<string> {
  return invoke<string>("check_ffmpeg");
}

/** Start a smart hybrid export. */
export function startExport(request: ExportRequest): Promise<ExportResult> {
  return invoke<ExportResult>("start_export", { request });
}

/** Cancel a running export. */
export function cancelExport(): Promise<void> {
  return invoke<void>("cancel_export");
}

/** Plan an export without running it — returns the piece breakdown for preview. */
export function planExport(request: ExportRequest): Promise<ExportPlan> {
  return invoke<ExportPlan>("plan_export", { request });
}

/**
 * Subscribe to live export progress events.
 * Returns an unsubscribe function.
 */
export async function onExportProgress(callback: (p: ExportProgress) => void): Promise<() => void> {
  const unlisten = await listen<ExportProgress>("export-progress", (e) => callback(e.payload));
  return unlisten;
}

/**
 * Tauri rejects command errors with the `Err` payload as-is, so this gives a
 * readable string no matter which layer produced the failure.
 */
export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Save (upsert) a project row so it appears in the Recent Projects grid. */
export function saveProject(
  dbPath: string,
  id: string,
  name: string,
  sourcePath: string,
  durationSecs: number,
  lastOpened: number,
): Promise<void> {
  return invoke<void>("save_project", {
    dbPath,
    id,
    name,
    sourcePath,
    durationSecs,
    lastOpened,
  });
}

/** List all projects, most recently opened first. */
export function loadProjects(dbPath: string): Promise<Project[]> {
  return invoke<Project[]>("load_projects", { dbPath });
}

/** Mark a project as opened now (updates `last_opened`). */
export function updateProjectOpened(
  dbPath: string,
  sourcePath: string,
  lastOpened: number,
): Promise<void> {
  return invoke<void>("update_project_opened", { dbPath, sourcePath, lastOpened });
}

/**
 * Reveal a file in Explorer, with it already selected — this is what
 * Clipchamp's "Open file location" menu row does.
 *
 * Routed through this module rather than imported by the component so the
 * shell keeps its one choke point (AGENTS.md §4). The plugin is registered
 * in src-tauri/src/lib.rs and `opener:default` is granted in
 * src-tauri/capabilities/default.json, so no Rust command is added here.
 */
export function revealInFolder(path: string): Promise<void> {
  return revealItemInDir(path);
}

/** Base URL of the t9cloud Go daemon (loopback only). */
const VAULT_BASE = "http://127.0.0.1:7878";

async function vaultJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${VAULT_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `vault ${path} failed (${res.status})`);
  }
  return res.json();
}

/** Current vault connection status. GET /v1/vault/status. */
export function vaultStatus(): Promise<VaultStatus> {
  return vaultJson<VaultStatus>("/v1/vault/status");
}

/** Start a QR login attempt. POST /v1/vault/authorise. */
export function vaultAuthorise(): Promise<LoginChallenge> {
  return vaultJson<LoginChallenge>("/v1/vault/authorise", { method: "POST" });
}

/** Poll the state of a login attempt. GET /v1/vault/authorise/{id}. */
export function vaultPollLogin(id: string): Promise<LoginChallenge> {
  return vaultJson<LoginChallenge>(`/v1/vault/authorise/${id}`);
}

/** Start a backup upload. POST /v1/vault/upload with { path, chat? }. */
export function vaultUpload(path: string, chat?: string): Promise<CloudJob> {
  return vaultJson<CloudJob>("/v1/vault/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, chat }),
  });
}

/** Poll a vault job for live progress. GET /v1/jobs/{id}. */
export function vaultJob(id: string): Promise<CloudJob> {
  return vaultJson<CloudJob>(`/v1/jobs/${id}`);
}

/** Open the native file picker for an audio file. Returns the selected path. */
export async function pickAudioFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Audio",
        extensions: ["mp3", "wav", "aac", "m4a", "ogg"],
      },
    ],
  });
  if (Array.isArray(selected)) {
    return selected[0] ?? null;
  }
  return selected ?? null;
}

/** Render a polish pass: music + optional ducking + text overlay. */
export function polishRender(
  source: string,
  output: string,
  settings: PolishSettings,
): Promise<PolishResult> {
  return invoke<PolishResult>("polish_render", { source, output, settings });
}

/** Absolute path to the .env file in app_data. */
export function envPath(): Promise<string> {
  return invoke<string>("env_path");
}

/** Read the .env file, returning entries and whether it exists. */
export function readEnvFile(path: string): Promise<EnvInfo> {
  return invoke<EnvInfo>("read_env_file", { path });
}

/** Write entries back to the .env file. */
export function writeEnvFile(path: string, entries: EnvEntry[]): Promise<void> {
  return invoke<void>("write_env_file", { path, entries });
}

// ── Drag & drop ────────────────────────────────────────────────────────────

/**
 * Extension set `MEDIA_EXTENSIONS` accepts as "importable media". Shared by
 * the file picker and the drop handler so both routes accept the same files.
 */
export const MEDIA_EXTENSIONS = [
  "mp4",
  "mkv",
  "mov",
  "webm",
  "avi",
  "m4v",
  "mp3",
  "wav",
  "aac",
  "m4a",
  "ogg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
] as const;

/** True when a dropped path looks like media this app can probe. */
export function isMediaPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (MEDIA_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Subscribe to files dragged in from Explorer.
 *
 * This is Tauri's native drag-drop, not HTML5 DnD: WebView2 never exposes a
 * dropped file's absolute path through `DataTransfer`, and the zero-RAM rule
 * means we cannot read the blob and guess. `onDragDropEvent` hands back real
 * paths, and — because the OS intercepts the drop — it also gives us the
 * hover/leave signals needed to paint the full-window "Drop to import" state.
 *
 * Returns an unsubscribe function, for use as the cleanup of an `$effect`.
 */
export async function onAppDrop(
  onDrop: (paths: string[]) => void,
  onHover?: (hovering: boolean) => void,
): Promise<() => void> {
  // Plain `vite dev` in a browser (no Tauri shell) has no `__TAURI_INTERNALS__`,
  // and `getCurrentWebview()` throws there. Importing a file still needs a real
  // OS path, which HTML5 DnD cannot give us — so outside the shell the
  // subscription is a no-op instead of an uncaught TypeError that would take
  // the whole DropLayer effect down with it.
  if (!("__TAURI_INTERNALS__" in window)) {
    return () => {};
  }
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((event) => {
    const kind = event.payload.type;
    if (kind === "drop") {
      onHover?.(false);
      const paths = event.payload.paths;
      if (paths.length > 0) onDrop(paths);
    } else if (kind === "enter" || kind === "over") {
      onHover?.(true);
    } else if (kind === "leave") {
      onHover?.(false);
    }
  });
}
