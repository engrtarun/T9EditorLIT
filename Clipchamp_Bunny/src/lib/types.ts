/** Core domain types for Nanami Cut. Mirrors what the Rust side will return later. */

/** The four zero-RAM modes. Only one is ever mounted at a time. */
export type Mode = 'ingest' | 'cut' | 'polish' | 'export';

/** Why the cloud brain flagged a line — drives the waveform colour. */
export type LineFlag = 'none' | 'fumble' | 'repeat' | 'wrong-example' | 'silence';

/** Keep = ✓ (stays in the final video). Cut = ✕ (skipped in preview + export). */
export type KeepState = 'keep' | 'cut';

/** One transcript line as Whisper returns it, plus our AI verdict. */
export interface TranscriptLine {
  id: string;
  /** Seconds from start of source. */
  startSec: number;
  endSec: number;
  /** Hinglish text exactly as spoken. */
  text: string;
  flag: LineFlag;
  /** AI pre-decision. The user can override with X / V. */
  keep: KeepState;
  /** 0..1 confidence from the cloud brain. */
  confidence: number;
  /** Clipchamp-style group id. Lines sharing a group move and delete together. */
  group?: string;
  /**
   * Word-level timings, when the engine has them (Whisper returns a `words`
   * array). With these, splitting a line also splits its **text** — cutting
   * "I LOVE U" at 4 s yields "I" and "LOVE U" instead of two identical rows.
   */
  words?: Array<{ word: string; start: number; end: number }>;
}

/** A media file. Never buffered — only a URL the <video> element streams from. */
export type MediaAsset = MediaInfo;

/** Normalised waveform peaks. Mirrors Rust `WaveformData` (serde camelCase). */
export interface WaveformData {
  durationSecs: number;
  bars: number;
  /** Absolute peak per bucket, 0..1. */
  peaks: number[];
  cachePath: string | null;
}

/** Filmstrip manifest. Mirrors Rust `ThumbnailStrip`. */
export interface ThumbnailStrip {
  durationSecs: number;
  fps: number;
  count: number;
  width: number;
  height: number;
  dir: string;
}

/** One audio chunk the Rust side split out, handed to the cloud transcriber. */
export interface AudioChunk {
  index: number;
  path: string;
  offsetSecs: number;
  durationSecs: number;
}

/** Real media metadata, mirrors the Rust `probe_cached` result. */
export interface MediaInfo {
  id: string;
  name: string;
  /** Object URL or tauri asset URL. The video element streams; we never read it into RAM. */
  url: string;
  durationSecs: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  videoCodec: string;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
}

/* ------------------------------------------------------------------ Rust IPC */

/** Live RAM reading from the Rust `get_memory_stats` command. */
export interface MemoryStats {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  /** What this app costs — host process plus its WebView2 children. */
  appMb: number;
  usedPercent: number;
}

/** One drive, for the "PC details" popover. */
export interface DiskInfo {
  name: string;
  mountPoint: string;
  totalGb: number;
  availableGb: number;
  usedPercent: number;
}

/** RAM reading for the status bar — mirrors Rust `RamReading`. */
export interface RamReading {
  /** This app's whole process tree, in MB. */
  appMb: number;
  /** The machine's total RAM, in MB. */
  totalMb: number;
  /** The machine's used RAM, in MB. */
  usedMb: number;
  /** The machine's used RAM, in percent. */
  usedPercent: number;
}

/** The drive the app's data folder lives on — mirrors Rust `DriveReading`. */
export interface DriveReading {
  /** Mount point, e.g. `C:\`. */
  mount: string;
  totalBytes: number;
  freeBytes: number;
}

/** Network throughput — mirrors Rust `NetReading`. */
export interface NetReading {
  /** Bytes per second, down. */
  downBps: number;
  /** Bytes per second, up. */
  upBps: number;
  /** The interface the numbers came from. */
  interface: string;
}

/** The machine's battery — mirrors Rust `BatteryReading`. */
export interface BatteryReading {
  /** Charge left, 0..100. */
  percent: number;
  /** True while the machine is plugged in. */
  charging: boolean;
}

/** One reading of every meter — mirrors Rust `SystemSnapshot`. */
export interface SystemSnapshot {
  ram: RamReading;
  drive: DriveReading;
  /** Bytes the app itself keeps on disk. */
  appStorageBytes: number;
  net: NetReading;
  /** `null` on a desktop that has no battery. */
  battery: BatteryReading | null;
}

/** Full machine snapshot from the Rust `system_details` command. */
export interface SystemDetails {
  osName: string;
  osVersion: string;
  hostName: string;
  kernel: string;
  cpuBrand: string;
  cpuCores: number;
  cpuThreads: number;
  cpuUsagePercent: number;
  cpuFrequencyMhz: number;
  ramTotalGb: number;
  ramUsedGb: number;
  ramAvailableGb: number;
  appMemoryMb: number;
  appCpuPercent: number;
  uptimeHours: number;
  disks: DiskInfo[];
}

/** A silent span, from the Rust `detect_silence` command. */
export interface SilenceRange {
  start: number;
  end: number;
}

/** A clip on the bottom timeline (video lane). */
export interface TimelineClip {
  id: string;
  startSec: number;
  endSec: number;
  /** Source in-point, so preview can seek. */
  inSec: number;
  label: string;
}

/** Text / zoom overlay on the text lane (Apna College style). */
export interface TextClip {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  kind: 'title' | 'heading' | 'code-zoom';
}

export interface ProjectState {
  name: string;
  media: MediaAsset | null;
  lines: TranscriptLine[];
  clips: TimelineClip[];
  texts: TextClip[];
  waveform: WaveformData | null;
}

/** Icon set used by the Fluent-style popover menus. */
export type MenuIcon =
  | 'rename'
  | 'folder'
  | 'plus'
  | 'trash'
  | 'copy'
  | 'cloud'
  | 'telegram'
  | 'spark'
  | 'bolt'
  | 'disk'
  | 'qr'
  | 'key';

/** One row in a popover menu. `divider: true` renders a separator instead of an item. */
export interface MenuItem {
  id: string;
  label: string;
  icon?: MenuIcon;
  /** Muted second line, e.g. the local path breadcrumb. */
  secondary?: string;
  danger?: boolean;
  divider?: boolean;
  disabled?: boolean;
}

/** Where a project can be backed up, or which AI brain does the work. */
export type ProviderId = 'telegram' | 'gemini' | 'groq' | 'local';

export type ProviderStatus = 'connected' | 'disconnected' | 'pending';

export interface ProviderState {
  id: ProviderId;
  label: string;
  detail: string;
  status: ProviderStatus;
  /** Badge on the right, e.g. the Telegram chat id or the API key mask. */
  badge?: string;
}
