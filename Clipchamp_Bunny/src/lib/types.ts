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
}

/** A media file. Never buffered — only a URL the <video> element streams from. */
export interface MediaAsset {
  id: string;
  name: string;
  /** Object URL or tauri asset URL. The video element streams; we never read it into RAM. */
  url: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
}

/** Normalised waveform peaks, 0..1, one entry per bucket. Mirrors Rust `WaveformData`. */
export interface WaveformData {
  peaks: number[];
  /** Seconds covered by each peak. */
  bucketSec: number;
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
