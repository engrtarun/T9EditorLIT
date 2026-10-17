/**
 * Domain model for the Clipchamp Clone editor.
 *
 * Shape is derived from the REA feature scan of the real Clipchamp web app
 * (`evidence/feature-map.json`), which found these subsystems across the
 * 46 bundled JS modules:
 *
 *   filters      10607 hits   — filter/look pipeline
 *   export       10183 hits   — codec/resolution/bitrate settings
 *   effects       6543 hits   — overlay/sticker/element layers
 *   transitions   6055 hits   — crossfade/dissolve between clips
 *   captions      2000 hits   — transcript + speech-to-text
 *   media         1420 hits   — thumbnail/proxy/aspect metadata
 *   trimming      1115 hits   — in/out points, split
 *   timeline       996 hits   — tracks, playhead, markers
 *   audio          507 hits   — waveform, volume, ducking
 *   text           473 hits   — styled text layers
 *   storage        260 hits   — autosave, asset library
 *   collab         126 hits   — comments, share links, versions
 *   ai              60 hits   — auto-cut, silence detect
 *
 * ZERO-RAM RULE (see AGENTS.md): nothing here holds media bytes. A `Asset`
 * is a path plus metadata. Waveform peaks are small precomputed arrays owned by
 * SQLite, never decoded audio in the heap.
 *
 * Mirrors the Rust structs in `src-tauri/src/model.rs`, which use
 * `#[serde(rename_all = "camelCase")]`.
 */

/** Video/audio/image/other, as resolved by ffprobe. */
export type AssetKind = "video" | "audio" | "image";

export interface Asset {
  id: string;
  /** Absolute path on disk. Media is never loaded into memory. */
  path: string;
  kind: AssetKind;
  durationSecs: number;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  /** Cheap preview tile; points at a file on disk, not an embedded bitmap. */
  thumbnailPath: string | null;
}

export type TrackKind = "video" | "overlay" | "audio" | "caption";

/**
 * A clip is a source Asset trimmed to a window and placed on the timeline.
 * `startSecs` is the timeline position of the clip's first frame.
 */
export interface Clip {
  id: string;
  assetId: string;
  trackId: string;
  startSecs: number;
  /** Length on the timeline after trimming. */
  durationSecs: number;
  /** Offset into the source asset where playback begins. */
  inPointSecs: number;
  outPointSecs: number;
  /** Seconds of source consumed per second of timeline, for speed changes. */
  speed: number;
  /** Linear gain 0–2. Clipchamp applies this as an FFmpeg `volume` filter. */
  volume: number;
  /** Whether this clip contributes audio to the mix. */
  muted: boolean;
  /** Per-clip transition applied at the head of the clip. */
  transition: TransitionKind | null;
}

export type Track = {
  id: string;
  kind: TrackKind;
  name: string;
  /** Top of the stack renders last; higher is visually on top. */
  heightPx: number;
  locked: boolean;
  muted: boolean;
};

/** Transition catalogue. Kept as a union so the UI and renderer agree. */
export type TransitionKind = "crossfade" | "dissolve" | "dip_to_black" | "wipe";

/**
 * Colour/look adjustment stack. Each key maps to one FFmpeg filter:
 * brightness/contrast/saturation are `eq`, temperature/tint are `colortemperature`,
 * vignette is `vignette`.
 */
export interface LookAdjustments {
  brightness: number; // -1 .. 1
  contrast: number; // -1 .. 1
  saturation: number; // -1 .. 1
  temperature: number; // -1 .. 1 (cool .. warm)
  tint: number; // -1 .. 1 (green .. magenta)
  vignette: number; // 0 .. 1
}

/** A named look preset from the filters catalogue. */
export interface LookPreset {
  id: string;
  label: string;
  adjustments: LookAdjustments;
}

/** Styled text layer — the `text` subsystem's unit of work. */
export interface TextLayer {
  id: string;
  trackId: string;
  startSecs: number;
  durationSecs: number;
  content: string;
  fontFamily: string;
  /** CSS-ish hex, e.g. `#ffffff`. */
  color: string;
  fontSizePx: number;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  /** Normalised 0–1 within the canvas, so it survives resolution changes. */
  x: number;
  y: number;
}

/** Transcript-backed caption, from the captions subsystem. */
export interface CaptionCue {
  id: string;
  startSecs: number;
  endSecs: number;
  text: string;
  /** Set once the user edits the auto-generated transcript. */
  edited: boolean;
}

/** Export settings — the single biggest keyword cluster in the real app. */
export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  /** Video bitrate in kbps. */
  videoKbps: number;
  audioKbps: number;
  codec: "h264" | "hevc" | "vp9";
  container: "mp4" | "mov" | "webm";
  /** Hardware encoder preference; i3 iGPU should land on qsv. */
  preferHardware: boolean;
}

export const ASPECT_PRESETS: ReadonlyArray<{
  label: string;
  width: number;
  height: number;
}> = [
  { label: "16:9", width: 1920, height: 1080 },
  { label: "9:16", width: 1080, height: 1920 },
  { label: "1:1", width: 1080, height: 1080 },
  { label: "4:5", width: 1080, height: 1350 },
];

/** Default export settings: 1080p30 H.264, conservative bitrate. */
export function defaultExportSettings(): ExportSettings {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    videoKbps: 8000,
    audioKbps: 192,
    codec: "h264",
    container: "mp4",
    preferHardware: true,
  };
}

/** Neutral look — the identity element for the filter pipeline. */
export function neutralLook(): LookAdjustments {
  return {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    vignette: 0,
  };
}
