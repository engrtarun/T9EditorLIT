import type {
  KeepState,
  LineFlag,
  MediaAsset,
  SilenceRange,
  TextClip,
  ThumbnailStrip,
  TimelineClip,
  TranscriptLine,
  WaveformData
} from '../types';
import { MOCK_LINES } from '../mock';
import {
  buildSegments,
  computeOffsets,
  dropIndex,
  editDuration as editDurationOf,
  editTimeAt,
  moveInOrder,
  orderLines,
  orderSegments,
  sourceAt
} from '../segments';
import { loadMediaInfo, loadThumbnails, loadWaveform } from '../media';
import { media } from './media.svelte';
import {
  assetUrl,
  defaultDbPath,
  demoSourcePath,
  detectSilence,
  extractThumbnails,
  extractWaveform,
  isTauri,
  loadTranscript,
  probeMedia,
  saveTranscript,
  setSourcePath
} from '../ipc';

/**
 * Undo snapshot. Holds the whole line array, not just the keep flags —
 * splits, trims, moves and groups all change the *structure*, so a
 * flags-only snapshot cannot undo them.
 *
 * The Rust backend persists the transcript (and therefore the undo log) in
 * SQLite; this in-memory copy is the prototype's stand-in. The history cap
 * keeps the heap bounded on long transcripts.
 */
type Snapshot = TranscriptLine[];

/**
 * Splitting produces `ln-012-1a` / `ln-012-1b`; undo must still find the parent.
 * The numeric tag is required — reusing the same `-a`/`-b` suffix twice would
 * produce duplicate keys and break Svelte's keyed `{#each}`.
 */
function baseId(id: string): string {
  return id.replace(/-[0-9a-z]+[ab]$/, '');
}

/**
 * Split a line's **text** at the cut point, when word-level timings are known.
 *
 * Cutting "I LOVE U" (10 s) at 4 s then yields two rows — "I" and "LOVE U" —
 * instead of two identical ones. Whisper returns a word array, so the backend
 * fills `words` in and this does the rest. Without word timings both halves
 * keep the original text, which is why the split still shows its time range.
 */
function applySplitText(left: TranscriptLine, right: TranscriptLine, at: number) {
  const words = left.words;
  if (!words?.length) return;
  const head = words.filter((w) => w.start < at);
  const tail = words.filter((w) => w.start >= at);
  if (!head.length || !tail.length) return;
  left.text = head
    .map((w) => w.word)
    .join(' ')
    .trim();
  right.text = tail
    .map((w) => w.word)
    .join(' ')
    .trim();
  left.words = head;
  right.words = tail;
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

  /** Monotonic counter so every split produces unique line ids. */
  private splitSeq = 0;

  past = $state<Snapshot[]>([]);
  future = $state<Snapshot[]>([]);

  /** True until the real media has been probed. */
  ready = $state(false);
  loadError = $state<string | null>(null);

  /** Filesystem path of the source, when running under Tauri. */
  sourcePath = $state<string | null>(null);

  durationSec = $derived(this.media?.durationSecs ?? 0);

  /**
   * Load the project source.
   *
   * In Tauri this goes through the real Rust engine: ffprobe → SQLite cache,
   * FFmpeg waveform, FFmpeg filmstrip, SQLite transcript. In the browser it
   * falls back to the media baked by `tools/generate-media.mjs`.
   */
  async init() {
    try {
      if (isTauri()) {
        const path = await demoSourcePath();
        if (path) {
          await this.loadFromBackend(path);
          return;
        }
      }
      await this.loadBaked();
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : String(e);
      this.ready = true;
    }
  }

  private async loadBaked() {
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
  }

  /** Real engine path: probe → waveform → filmstrip → transcript (SQLite). */
  async loadFromBackend(path: string) {
    const info = await probeMedia(path);
    this.media = {
      id: crypto.randomUUID(),
      name: path.split(/[\\/]/).pop() ?? 'video',
      url: assetUrl(path),
      durationSecs: info.durationSecs,
      width: info.width ?? 0,
      height: info.height ?? 0,
      fps: info.fps ?? 0,
      sizeBytes: info.sizeBytes,
      videoCodec: info.videoCodec ?? 'unknown',
      audioCodec: info.audioCodec,
      sampleRate: null,
      channels: null
    };
    this.name = this.media.name.replace(/\.[^.]+$/, '');
    this.sourcePath = path;
    setSourcePath(path);

    const [wave, thumbs] = await Promise.all([
      extractWaveform(path).catch(() => null),
      extractThumbnails(path).catch(() => null)
    ]);
    if (wave) this.waveform = wave;
    if (thumbs) this.thumbnails = thumbs;

    try {
      const db = await defaultDbPath();
      const stored = await loadTranscript(db, path);
      if (stored?.length) {
        this.lines = stored.map((l) => ({
          id: l.id,
          startSec: l.startSecs,
          endSec: l.endSecs,
          text: l.text,
          flag: (l.flag as LineFlag) ?? 'none',
          keep: l.keep ? 'keep' : 'cut',
          confidence: 1,
          // Word timings ride along, so a split can cut the *text* too.
          words: l.words?.map((w) => ({ word: w.word, start: w.start, end: w.end }))
        }));
      } else {
        this.lines = scaleLines(MOCK_LINES, info.durationSecs);
      }
    } catch {
      this.lines = scaleLines(MOCK_LINES, info.durationSecs);
    }
    this.ready = true;
  }

  /**
   * Find the silent spans in the source. Clipchamp's AI auto-cut scans for
   * pauses longer than three seconds — that is the default here too.
   */
  async findSilences(minSecs = 3.0): Promise<SilenceRange[]> {
    const path = this.sourcePath;
    if (!path || !isTauri()) return [];
    return detectSilence(path, -30, minSecs);
  }

  /** Mark every transcript line that overlaps one of the given spans as cut. */
  cutSilences(ranges: SilenceRange[]): number {
    if (!ranges.length) return 0;
    this.commit();
    const cut = new Set<string>();
    for (const l of this.lines) {
      for (const r of ranges) {
        if (l.endSec > r.start && l.startSec < r.end) {
          cut.add(l.id);
          break;
        }
      }
    }
    if (cut.size) {
      this.lines = this.lines.map((l) => (cut.has(l.id) ? { ...l, keep: 'cut' as KeepState } : l));
    }
    return cut.size;
  }

  /**
   * Auto-cut silence — Clipchamp's "AI suggestions / remove silences".
   * Uses the Rust `detect_silence` command (FFmpeg `silencedetect`), then
   * marks every transcript line that overlaps a silent span as cut.
   */
  async autoCutSilence(minSecs = 3.0): Promise<number> {
    const ranges = await this.findSilences(minSecs);
    return this.cutSilences(ranges);
  }

  /** Persist the current transcript + cut decisions to SQLite. */
  async persist() {
    const path = this.sourcePath;
    if (!path || !isTauri()) return false;
    try {
      const db = await defaultDbPath();
      await saveTranscript(
        db,
        path,
        this.lines.map((l) => ({
          id: l.id,
          startSecs: l.startSec,
          endSecs: l.endSec,
          text: l.text,
          flag: l.flag,
          keep: l.keep === 'keep',
          originalText: '',
          words: l.words
        }))
      );
      return true;
    } catch {
      return false;
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

  /**
   * The **edit timeline**: the kept segments in final-video order.
   *
   * This is what the video lane shows and what you can drag around. A segment
   * owns the transcript lines that produced it, so reordering a segment
   * reorders those lines in the transcript panel — live.
   *
   * The maths lives in `lib/segments.ts` (pure, unit-tested).
   */
  segments = $derived(buildSegments(this.lines));

  /** Order of the segment ids, as the user arranged them on the timeline. */
  segmentOrder = $state<string[]>([]);

  /** Segments in final-video order, honouring the user's drag order. */
  orderedSegments = $derived(orderSegments(this.segments, this.segmentOrder));

  /** Edit-axis position of every segment: where it starts in the final video. */
  segmentOffsets = $derived(computeOffsets(this.orderedSegments));

  /**
   * Where the split marks land on the edit timeline, so the video lane can
   * draw a divider for every split the user made.
   */
  splitMarkPositions = $derived.by(() => {
    const out: number[] = [];
    for (const mark of this.splitMarks) {
      for (const s of this.orderedSegments) {
        const off = this.segmentOffsets.get(s.id);
        if (!off) continue;
        if (mark >= s.startSec && mark <= s.endSec) {
          out.push(off.start + (mark - s.startSec));
          break;
        }
      }
    }
    return out;
  });

  /** Total length of the final video (all kept segments, in order). */
  editDuration = $derived(editDurationOf(this.orderedSegments));

  /** Source time → position on the edit timeline (null when inside a cut). */
  editTimeAt = (sourceSec: number): number | null =>
    editTimeAt(this.orderedSegments, this.segmentOffsets, sourceSec);

  /** Position on the edit timeline → source time (null when past the end). */
  sourceAt = (editSec: number): number | null =>
    sourceAt(this.orderedSegments, this.segmentOffsets, editSec);

  /** Move a segment to a new position in the final video. */
  moveSegment(fromId: string, toIndex: number) {
    const order = this.orderedSegments.map((s) => s.id);
    const next = moveInOrder(order, fromId, toIndex);
    if (next.join() === order.join()) return;
    this.commit();
    this.segmentOrder = next;
  }

  /** Transcript lines in final-video order (used by the transcript panel). */
  orderedLines = $derived(orderLines(this.orderedSegments, this.lines));

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

  /** Open a library entry as the current project (a new project, in effect). */
  async openLibraryEntry(id: string) {
    const e = media.get(id);
    if (!e) return;
    if (e.path) {
      await this.loadFromBackend(e.path);
    } else if (e.asset.url) {
      // a browser blob — no engine, just the streamed file
      this.media = e.asset;
      this.name = e.asset.name.replace(/\.[^.]+$/, '');
    } else {
      return;
    }
    for (const other of media.entries) media.markUnused(other.asset.id);
    media.markInUse(id);
  }

  /**
   * Import one or more files from disk. The **last** one becomes the current
   * project — bringing a new file in while editing starts a new project, which
   * is what a file manager user expects.
   */
  async importPaths(paths: string[]) {
    if (!paths.length) return;
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() ?? p;
      media.addPath(p, name);
    }
    const last = paths[paths.length - 1];
    const entry = media.byPath(last);
    if (entry) await this.openLibraryEntry(entry.asset.id);
  }

  /** User-dropped files in the browser (no filesystem path). */
  async importBlobs(files: File[]) {
    if (!files.length) return;
    for (const f of files) {
      if (!f.type.startsWith('video/') && !f.type.startsWith('audio/')) continue;
      const url = URL.createObjectURL(f);
      const entry = media.add(f, url);
      this.media = entry.asset;
      this.name = f.name.replace(/\.[^.]+$/, '');
    }
    for (const other of media.entries) media.markUnused(other.asset.id);
  }

  /** User-dropped files in the desktop app — they have a real path. */
  async importDropped(files: File[]) {
    if (!isTauri()) return this.importBlobs(files);
    // The webview cannot read a real path for a dropped file, so the file is
    // streamed as a blob and probed by the engine from the temp copy.
    await this.importBlobs(files);
  }

  /** User-dropped files must not navigate the window away. */
  private snapshot(): Snapshot {
    // Plain object copies — `structuredClone` cannot clone Svelte's reactive
    // proxies, and every TranscriptLine field is a primitive anyway.
    return this.lines.map((l) => ({ ...l }));
  }

  private apply(snap: Snapshot) {
    this.lines = snap.map((l) => ({ ...l }));
    this.cursor = Math.max(0, Math.min(this.lines.length - 1, this.cursor));
    this.selectedIds = [];
  }

  private commit() {
    this.past.push(this.snapshot());
    if (this.past.length > 30) this.past.shift();
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

  /** Source seconds where the user split a line — drawn as dividers on the timeline. */
  splitMarks = $state<number[]>([]);

  /**
   * Split a transcript line in two (Clipchamp's ✂ / `S`).
   *
   * Targeting rules, in order:
   *   1. The playhead is strictly inside a line → split that line at the playhead.
   *   2. Otherwise the cursor line is used, and the cut point is clamped so it
   *      always lands strictly inside the line. (Clicking a transcript row seeks
   *      the playhead to that line's *start*, so without the clamp `S` would
   *      silently do nothing.)
   */
  splitAt(sec: number): boolean {
    let idx = this.lineAt(sec);
    const under = idx >= 0 ? this.lines[idx] : null;
    const strictlyInside = (l: TranscriptLine) => sec > l.startSec + 0.25 && sec < l.endSec - 0.25;

    if (!under || !strictlyInside(under)) {
      if (!this.lines[this.cursor]) return false;
      idx = this.cursor;
    }

    const line = this.lines[idx];
    // Clipchamp's AI auto-cut treats 3 s+ as a cuttable silence; for a manual
    // split we only need a usable sliver, so 0.25 s is the floor.
    if (line.endSec - line.startSec < 0.5) return false;
    const at = Math.max(line.startSec + 0.25, Math.min(line.endSec - 0.25, sec));

    this.commit();
    const base = baseId(line.id);
    const tag = (++this.splitSeq).toString(36);
    const left: TranscriptLine = { ...line, id: `${base}-${tag}a`, endSec: at };
    const right: TranscriptLine = { ...line, id: `${base}-${tag}b`, startSec: at };
    applySplitText(left, right, at);
    this.lines = [...this.lines.slice(0, idx), left, right, ...this.lines.slice(idx + 1)];
    this.splitMarks = [...this.splitMarks, at].sort((a, b) => a - b);
    this.cursor = idx + 1;
    return true;
  }

  /**
   * **Cut at the playhead** — the gesture the user actually performs: drop the
   * playhead inside a line ("I LOVE U", 10 s) and cut at 4 s. The line is split
   * there and the *head* is marked cut, so the transcript shows the two halves
   * as separate rows and the timeline shows the gap.
   */
  cutAtPlayhead(sec: number): boolean {
    const idx = this.lineAt(sec);
    if (idx < 0) return false;
    const line = this.lines[idx];
    if (sec <= line.startSec + 0.15 || sec >= line.endSec - 0.15) return false;

    this.commit();
    const base = baseId(line.id);
    const tag = (++this.splitSeq).toString(36);
    const left: TranscriptLine = {
      ...line,
      id: `${base}-${tag}a`,
      endSec: sec,
      keep: 'cut' as KeepState
    };
    const right: TranscriptLine = {
      ...line,
      id: `${base}-${tag}b`,
      startSec: sec,
      keep: 'keep' as KeepState
    };
    applySplitText(left, right, sec);
    this.lines = [...this.lines.slice(0, idx), left, right, ...this.lines.slice(idx + 1)];
    this.splitMarks = [...this.splitMarks, sec].sort((a, b) => a - b);
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
