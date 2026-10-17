/**
 * The single place that talks to Rust.
 *
 * Every `invoke` call in the app goes through a named wrapper here, so the
 * command names and payload shapes are validated in one spot instead of being
 * scattered across components as raw strings.
 */

import { invoke } from "@tauri-apps/api/core";
import type { HardwareSupport, MediaInfo, MemoryStats } from "./types";

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

/** FFmpeg version string, or a thrown error if FFmpeg is not usable. */
export function checkFfmpeg(): Promise<string> {
  return invoke<string>("check_ffmpeg");
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
