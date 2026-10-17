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

/** One recently opened project, for the Home Screen grid. */
export interface Project {
  id: string;
  name: string;
  sourcePath: string;
  durationSecs: number;
  lastOpened: number;
}

/** One extracted audio chunk produced by FFmpeg, ready for Whisper. */
export interface AudioChunk {
  index: number;
  path: string;
  offsetSecs: number;
  durationSecs: number;
}

/**
 * A ~1 fps thumbnail strip cached as JPEGs on disk. `dir` holds the frames
 * (`thumb_00001.jpg`, …); the frontend derives each path and loads it through
 * the Tauri asset protocol, so the images never enter JS memory.
 */
export interface ThumbnailStrip {
  durationSecs: number;
  fps: number;
  count: number;
  width: number;
  height: number;
  dir: string;
}

/**
 * Waveform peaks for the timeline, one per bucket, normalized 0–1. Cached as
 * JSON on disk keyed by source mtime, so a reload skips FFmpeg entirely.
 */
export interface WaveformData {
  durationSecs: number;
  bars: number;
  peaks: number[];
  cachePath?: string;
}

/** Segment shape returned by the t9cloud Go daemon (snake_case JSON). */
export interface CloudSegment {
  id: string;
  start_secs: number;
  end_secs: number;
  text: string;
  flag: "none" | "silence" | "fumble" | "retake" | "wrong_example";
  keep: boolean;
  reason?: string;
}

/** Job shape returned by t9cloud. */
export interface CloudJob {
  id: string;
  kind: string;
  state: "queued" | "running" | "done" | "failed" | "partial";
  createdUnix: number;
  updatedUnix: number;
  total: number;
  completed: number;
  error: string | null;
  transcript?: CloudSegment[];
  analysis?: CloudSegment[];
  vaultProgress: VaultProgress | null;
  vaultResult: VaultResult | null;
}

/** One kept segment handed to the export engine. */
export interface ExportSegment {
  start: number;
  end: number;
}

/** What kind of piece: stream copy or micro-encode. */
export type PieceKind = "copy" | "encode";

/** One piece of work in the export plan. */
export interface ExportPiece {
  index: number;
  segmentIndex: number;
  start: number;
  end: number;
  kind: PieceKind;
  durationSecs: number;
}

/** The full export plan returned by plan_export. */
export interface ExportPlan {
  source: string;
  output: string;
  mode: string;
  durationSecs: number;
  outputDurationSecs: number;
  segments: ExportSegment[];
  pieces: ExportPiece[];
  copyPieces: number;
  encodePieces: number;
  encoder: string | null;
  keyframeCount: number;
  audioCopied: boolean;
  estimatedSizeBytes: number;
  warnings: string[];
}

/** Export options. */
export interface ExportOptions {
  mode?: string;
  alignToleranceMs?: number;
}

/** Export request. */
export interface ExportRequest {
  source: string;
  segments: ExportSegment[];
  output: string;
  options?: ExportOptions;
  dbPath?: string | null;
}

/** Export result. */
export interface ExportResult {
  output: string;
  durationSecs: number;
  sizeBytes: number;
  pieceCount: number;
  encoder: string | null;
  warnings: string[];
}

/** Export progress event payload. */
export interface ExportProgress {
  stage: string;
  pieceIndex: number;
  pieceCount: number;
  percent: number;
  message: string;
}

/** Telegram Vault connection status, from GET /v1/vault/status. */
export interface VaultStatus {
  configured: boolean;
  authorised: boolean;
  account: string | null;
  chat: string | null;
  connections: number;
  partBytes: number;
  sessionPath: string | null;
  detail: string | null;
}

/** QR login challenge, from POST /v1/vault/authorise or GET /v1/vault/authorise/{id}. */
export interface LoginChallenge {
  id: string;
  url: string | null;
  expiresUnix: number | null;
  phase: "waiting" | "authorised" | "expired" | "password_needed" | "failed";
  detail: string | null;
  rotations: number;
  account: string | null;
}

/** One snapshot of a running vault upload, from GET /v1/jobs/{id}.vault_progress. */
export interface VaultProgress {
  phase: "hashing" | "uploading" | "done";
  partsDone: number;
  partCount: number;
  partIndex: number;
  bytesDone: number;
  bytesTotal: number;
  bytesPerSec: number;
  connections: number;
  message: string | null;
}

/** Upload outcome for a completed vault job. */
export interface VaultResult {
  chatId: string | null;
  messageIds: number[];
  partCount: number;
  totalBytes: number;
  completedAt: number | null;
}
