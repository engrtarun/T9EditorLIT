/**
 * TypeScript mirrors of the Rust structs in `src-tauri/src/`.
 *
 * Rust types are `#[serde(rename_all = "camelCase")]`, so these use camelCase
 * to match. Keep the two sides in sync — a mismatch here surfaces as `undefined`
 * at runtime rather than a compile error, which is exactly the kind of bug that
 * wastes an afternoon on a 5 GB render.
 */

export interface MemoryStats {
  /** Physical RAM installed, in MB. */
  totalMb: number;
  /** In use by everything (Windows, Chrome, Telegram, ...), in MB. */
  usedMb: number;
  /** Available for new allocations, in MB. */
  availableMb: number;
  /** What T9EditorLIT itself costs — host process plus WebView2 children. */
  appMb: number;
  /** 0–100. */
  usedPercent: number;
}

export interface StreamInfo {
  index: number;
  codecType: string;
  codecName: string | null;
  width: number | null;
  height: number | null;
  avgFrameRate: string | null;
  pixFmt: string | null;
  channels: number | null;
  sampleRate: string | null;
}

export interface MediaInfo {
  path: string;
  /** Seconds. */
  durationSecs: number;
  sizeBytes: number;
  /** Frames per second, already resolved from `num/den` (e.g. 59.94). */
  fps: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  pixFmt: string | null;
  hasAudio: boolean;
  streams: StreamInfo[];
}

export interface HardwareSupport {
  /** Intel QuickSync — expected true on an i3 iGPU. */
  qsv: boolean;
  nvenc: boolean;
  amf: boolean;
}

/**
 * One transcript line, as it will exist from Chunk 2 onward.
 * Declared now so the Cut Panel component compiles against a real shape.
 */
export interface TranscriptLine {
  id: string;
  startSecs: number;
  endSecs: number;
  text: string;
  /** `false` means cut (✕). Defaults to keep so nothing is lost by accident. */
  keep: boolean;
  /** Why the AI flagged it, when it did — silence, fumble, retake, wrong example. */
  flag: "none" | "silence" | "fumble" | "retake" | "wrong_example";
}
