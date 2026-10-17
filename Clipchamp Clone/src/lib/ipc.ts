/**
 * Single typed choke point to Rust.
 *
 * Per AGENTS.md, Svelte components must never call `invoke()` directly —
 * they import from here. That way a Rust signature change surfaces as one
 * TypeScript error instead of scattered runtime `undefined`s.
 *
 * Mirrors the `#[tauri::command]` set in `src-tauri/src/lib.rs`.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Asset, ExportSettings } from "./types.js";

/**
 * Probe a media file. Returns duration, dimensions, fps and codecs.
 *
 * Resolved by a short-lived `ffprobe` child process — the file is never
 * read into the heap, which is what keeps 4K/60 footage viable on 8 GB RAM.
 */
export function probeMedia(path: string): Promise<Asset> {
  return invoke<Asset>("probe_media", { path });
}

/**
 * Build (but not run) the FFmpeg export command.
 *
 * Returning argv rather than rendering lets the UI show exactly what would
 * be spawned, and keeps the Rust side testable without spawning anything.
 */
export function buildExportCommand(
  input: string,
  output: string,
  settings: ExportSettings,
): Promise<string[]> {
  return invoke<string[]>("build_export_command", { input, output, settings });
}
