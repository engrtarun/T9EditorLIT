import type {
  KeepState,
  MediaAsset,
  TextClip,
  ThumbnailStrip,
  TimelineClip,
  TranscriptLine,
  WaveformData
} from '../types';
import { MOCK_LINES } from '../mock';
import { loadMediaInfo, loadThumbnails, loadWaveform } from '../media';

type Snapshot = Record<string, KeepState>;

/** Splitting produces `ln-012-a` / `ln-012-b`; undo must still find the parent. */
function baseId(id: string): string {
  return id.replace(/-[ab]$/, '');
}

class ProjectStore {
  name = $state('apna-college-vite-intro');
  media = $state<MediaAsset | null>(null);
  lines = $state<TranscriptLine[]>([]);
  clips = $state<TimelineClip[]>([]);
  texts = $state<TextClip[]>([
    { id: 't1', startSec: 10, endSec: 20, text: 'Vite kya hai?', kind: 'title' },
    { id: 't2', startSec: 96, endSec: 112, text: 'Config & Plugins', kind: 'heading' },
    { id: 't3', startSec: 126, endSec: 142, text: 'npm install vite', kind: 'code-zoom' }
  ]);
  waveform = $state<WaveformData | null>(null);
  thumbnails = $state<ThumbnailStrip | null>(null);

  /** Index of the transcript line the keyboard cursor sits on. */
  cursor = $state(0);

  /** Multi-selection (Clipchamp: Ctrl+A / Esc / TAB+ENTER). */
  selectedIds = $state<string[]>([]);

  /** Clipboard for Ctrl+C / Ctrl+V. */
  clipboard = $state<TranscriptLine | null>(null);

  /** Magnet: playhead snaps to line boundaries when true. */
  snap = $state(true);

  /** Right-rail CC toggle — hides/shows the transcript panel. */
  showTranscript = $state(true);

  past = $state<Snapshot[]>([]);
  future = $state<Snapshot[]>([]);

  /** True until the real media has been probed. */
  ready = $state(false);
  loadError = $state<string | null>(null);

  durationSec = $derived(this.media?.durationSecs ?? 0);

  /**
   * Load the real demo media. In the Tauri build this is replaced by the Rust
   * `probe_cached` / `extract_waveform` / `extract_thumbnails` commands.
   */
  async init() {
    try {
      const [media, waveform, thumbnails] = await Promise.all([
        loadMediaInfo(),
        loadWaveform(),
        loadThumbnails()
      ]);
      this.media = media;
      this.name = media.name.replace(/\.[^.]+$/, '');
      this.waveform = waveform;
      this.thumbnails = thumbnails;
      this.lines = scaleLines(MOCK_LINES, media.durationSecs);
      this.ready = true;
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : String(e);
      this.ready = true;
    }
  }

  /** Merged [start, end] ranges to skip — this is the Phantom Cut. */
  cutRanges = $derived.by(() => {
    const ranges: Array<[number, number]> = [];
    for (const line of this.lines) {
      if (line.keep === 'keep') continue;
      const last = ranges[ranges.length - 1];
      if (last && line.startSec - last[1] < 0.35) last[1] = Math.max(last[1], line.endSec);
      else ranges.push([line.startSec, line.endSec]);
    }
    return ranges;
  });

  /** Merged ranges that survive the cut — these become the clips on the video lane. */
  keptRanges = $derived.by(() => {
    const ranges: Array<[number, number]> = [];
    for (const line of this.lines) {
      if (line.keep === 'cut') continue;
      const last = ranges[ranges.length - 1];
      if (last && line.startSec - last[1] < 0.35) last[1] = Math.max(last[1], line.endSec);
      else ranges.push([line.startSec, line.endSec]);
    }
    return ranges;
  });

  keptSec = $derived.by(() =>
    this.lines.reduce((sum, l) => sum + (l.keep === 'keep' ? l.endSec - l.startSec : 0), 0)
  );

  cutSec = $derived(Math.max(0, this.durationSec - this.keptSec));

  cutCount = $derived(this.lines.filter((l) => l.keep === 'cut').length);
  keptCount = $derived(this.lines.filter((l) => l.keep === 'keep').length);

  /** Line under the playhead, used for X / V. */
  lineAt = (sec: number) => {
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      if (sec >= l.startSec && sec < l.endSec) return i;
    }
    return -1;
  };

  isCutAt = (sec: number) => this.cutRanges.some(([a, b]) => sec >= a && sec < b);

  /**
   * Phantom Cut — returns the corrected playback time if `sec` falls inside a cut range.
   * The <video> loop calls this on every timeupdate; nothing is re-encoded here.
   */
  skipCuts = (sec: number): number => {
    for (const [a, b] of this.cutRanges) {
      if (sec >= a && sec < b) return b;
    }
    return sec;
  };

  private snapshot(): Snapshot {
    return Object.fromEntries(this.lines.map((l) => [l.id, l.keep]));
  }

  private apply(snap: Snapshot) {
    this.lines = this.lines.map((l) => {
      const next = snap[l.id] ?? snap[baseId(l.id)];
      return next && next !== l.keep ? { ...l, keep: next } : l;
    });
  }

  private commit() {
    this.past.push(this.snapshot());
    if (this.past.length > 120) this.past.shift();
    this.future.length = 0;
  }

  toggleLine(id: string) {
    this.commit();
    this.lines = this.lines.map((l) =>
      l.id === id ? { ...l, keep: l.keep === 'keep' ? 'cut' : 'keep' } : l
    );
  }

  setLine(id: string, keep: KeepState) {
    const line = this.lines.find((l) => l.id === id);
    if (!line || line.keep === keep) return;
    this.commit();
    this.lines = this.lines.map((l) => (l.id === id ? { ...l, keep } : l));
  }

  /** One-hand arcade flow: after every X / V the cursor falls to the next line. */
  step(delta: number) {
    this.cursor = Math.max(0, Math.min(this.lines.length - 1, this.cursor + delta));
    return this.lines[this.cursor];
  }

  undo() {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.snapshot());
    this.apply(prev);
    return true;
  }

  redo() {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.snapshot());
    this.apply(next);
    return true;
  }

  /* ------------------------------------------------------------ selection */
  isSelected = (id: string) => this.selectedIds.includes(id);

  toggleSelect(id: string) {
    this.selectedIds = this.isSelected(id)
      ? this.selectedIds.filter((x) => x !== id)
      : [...this.selectedIds, id];
  }

  selectAll() {
    this.selectedIds = this.lines.map((l) => l.id);
  }

  deselectAll() {
    this.selectedIds = [];
  }

  /** The lines a destructive command should act on: the selection, else the cursor line. */
  targets(): TranscriptLine[] {
    if (this.selectedIds.length) return this.lines.filter((l) => this.isSelected(l.id));
    const cur = this.lines[this.cursor];
    return cur ? [cur] : [];
  }

  /** Cut every targeted line (Del / Backspace). */
  cutTargets() {
    const targets = this.targets();
    if (!targets.length) return;
    this.commit();
    const ids = new Set(targets.map((t) => t.id));
    this.lines = this.lines.map((l) => (ids.has(l.id) ? { ...l, keep: 'cut' as KeepState } : l));
    this.selectedIds = [];
  }

  /* ------------------------------------------------------------ clipboard */
  copyCurrent() {
    const cur = this.lines[this.cursor];
    if (cur) this.clipboard = { ...cur };
  }

  pasteAfterCurrent() {
    if (!this.clipboard) return;
    this.commit();
    const at = this.cursor + 1;
    const src = this.clipboard;
    const inserted: TranscriptLine = {
      ...src,
      id: `${baseId(src.id)}-p${Date.now().toString(36).slice(-4)}`,
      startSec: src.endSec,
      endSec: src.endSec + (src.endSec - src.startSec)
    };
    this.lines = [...this.lines.slice(0, at), inserted, ...this.lines.slice(at)];
    this.cursor = at;
  }

  duplicateCurrent() {
    this.clipboard = this.lines[this.cursor] ? { ...this.lines[this.cursor] } : null;
    this.pasteAfterCurrent();
  }

  /* ------------------------------------------------------------ trim / move */
  /** Clipchamp: Z + ← / →  (trim the start of the item). */
  trimStart(delta: number) {
    const cur = this.lines[this.cursor];
    if (!cur) return;
    const next = Math.max(0, Math.min(cur.endSec - 0.3, cur.startSec + delta));
    if (Math.abs(next - cur.startSec) < 0.01) return;
    this.commit();
    this.lines = this.lines.map((l) => (l.id === cur.id ? { ...l, startSec: next } : l));
  }

  /** Clipchamp: C + ← / →  (trim the end of the item). */
  trimEnd(delta: number) {
    const cur = this.lines[this.cursor];
    if (!cur) return;
    const next = Math.max(cur.startSec + 0.3, cur.endSec + delta);
    if (Math.abs(next - cur.endSec) < 0.01) return;
    this.commit();
    this.lines = this.lines.map((l) => (l.id === cur.id ? { ...l, endSec: next } : l));
  }

  /** Clipchamp: X + ← / →  (move the item earlier / later). */
  moveCurrent(delta: number) {
    const from = this.cursor;
    const to = from + delta;
    if (from < 0 || from >= this.lines.length || to < 0 || to >= this.lines.length) return;
    this.commit();
    const next = [...this.lines];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    this.lines = next;
    this.cursor = to;
  }

  /* ------------------------------------------------------------ grouping */
  groupSelected() {
    const targets = this.targets();
    if (targets.length < 2) return;
    this.commit();
    const g = `g${Date.now().toString(36).slice(-5)}`;
    const ids = new Set(targets.map((t) => t.id));
    this.lines = this.lines.map((l) => (ids.has(l.id) ? { ...l, group: g } : l));
    this.selectedIds = [];
  }

  ungroupSelected() {
    const targets = this.targets();
    if (!targets.length) return;
    this.commit();
    const ids = new Set(targets.map((t) => t.id));
    this.lines = this.lines.map((l) => {
      if (!ids.has(l.id)) return l;
      const { group: _g, ...rest } = l;
      return rest;
    });
    this.selectedIds = [];
  }

  /**
   * Split the transcript line under the playhead into two (Clipchamp's ✂).
   * The right half inherits the parent's verdict, the left half keeps the text.
   */
  splitAt(sec: number): boolean {
    const idx = this.lineAt(sec);
    if (idx < 0) return false;
    const line = this.lines[idx];
    if (sec <= line.startSec + 0.2 || sec >= line.endSec - 0.2) return false;

    this.commit();
    const base = baseId(line.id);
    const left: TranscriptLine = { ...line, id: `${base}-a`, endSec: sec };
    const right: TranscriptLine = { ...line, id: `${base}-b`, startSec: sec };
    this.lines = [...this.lines.slice(0, idx), left, right, ...this.lines.slice(idx + 1)];
    this.cursor = idx + 1;
    return true;
  }

  /** Magnet behaviour: snap a time to the nearest line boundary within a tolerance. */
  snapTime(sec: number, toleranceSec = 0.25): number {
    if (!this.snap) return sec;
    let best = sec;
    let bestDist = toleranceSec;
    for (const l of this.lines) {
      for (const edge of [l.startSec, l.endSec]) {
        const d = Math.abs(edge - sec);
        if (d < bestDist) {
          bestDist = d;
          best = edge;
        }
      }
    }
    return best;
  }

  /** User-dropped file replaces the demo media. */
  loadFile(file: File, url: string) {
    this.name = file.name.replace(/\.[^.]+$/, '');
    this.media = {
      id: crypto.randomUUID(),
      name: file.name,
      url,
      durationSecs: 0,
      width: 0,
      height: 0,
      fps: 0,
      sizeBytes: file.size,
      videoCodec: 'unknown',
      audioCodec: null,
      sampleRate: null,
      channels: null
    };
  }
}

/** Stretch the mock transcript onto the real media duration. */
function scaleLines(lines: TranscriptLine[], durationSec: number): TranscriptLine[] {
  const mockDur = lines[lines.length - 1]?.endSec ?? 1;
  const k = durationSec / mockDur;
  return lines.map((l) => ({
    ...l,
    startSec: Number((l.startSec * k).toFixed(2)),
    endSec: Number((l.endSec * k).toFixed(2))
  }));
}

export const project = new ProjectStore();
