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
import { runAnalysis, runCorrection, runTranscription, toLineFlag } from '../pipeline';
import {
  assetUrl,
  canonicalSourcePath,
  defaultDbPath,
  demoSourcePath,
  detectSilence,
  extractAudioChunks,
  extractThumbnails,
  extractWaveform,
  isTauri,
  loadProjects,
  loadTranscript,
  logAppEvent,
  logEditAction,
  probeMedia,
  resumeProject,
  saveProject,
  saveTranscript,
  setSourcePath,
  updateProjectOpened
} from '../ipc';
import type { RustProject } from '../ipc';

/**
 * Undo snapshot. Holds the whole line array, not just the keep flags â€”
 * splits, trims, moves and groups all change the *structure*, so a
 * flags-only snapshot cannot undo them.
 *
 * The Rust backend persists the transcript (and therefore the undo log) in
 * SQLite; this in-memory copy is the prototype's stand-in. The history cap
 * keeps the heap bounded on long transcripts.
 */
interface Snapshot {
  lines: TranscriptLine[];
  texts: TextClip[];
  segmentOrder: string[];
  splitMarks: number[];
  mutedSegments: string[];
  hiddenTracks: TrackId[];
}

export type TrackId = 'text' | 'video' | 'audio';

/**
 * Splitting produces `ln-012-1a` / `ln-012-1b`; undo must still find the parent.
 * The numeric tag is required â€” reusing the same `-a`/`-b` suffix twice would
 * produce duplicate keys and break Svelte's keyed `{#each}`.
 */
function baseId(id: string): string {
  return id.replace(/-[0-9a-z]+[ab]$/, '');
}

/**
 * Split a line's **text** at the cut point, when word-level timings are known.
 *
 * Cutting "I LOVE U" (10 s) at 4 s then yields two rows â€” "I" and "LOVE U" â€”
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
  /**
   * The project name.
   *
   * It starts empty and is filled from the file that is actually loaded, so
   * the top bar never shows a leftover prototype name.
   */
  name = $state('');
  media = $state<MediaAsset | null>(null);
  lines = $state<TranscriptLine[]>([]);
  clips = $state<TimelineClip[]>([]);
  /**
   * Text overlays for the timeline's T lane.
   *
   * Empty on purpose: these were three hardcoded prototype captions ("Vite
   * kya hai?" and friends) that showed up over **every** video, real or not.
   * The lane stays in the UI, ready for real captions.
   */
  texts = $state<TextClip[]>([]);
  /** Selected text clip on the T lane (separate from transcript selection). */
  selectedTextId = $state<string | null>(null);
  /** Clip ids whose audio is muted (Clipchamp's speaker button on the clip). */
  mutedSegments = $state<string[]>([]);
  /** Whole tracks hidden by the eye/Hide control. */
  hiddenTracks = $state<TrackId[]>([]);
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

  /** Right-rail CC toggle â€” hides/shows the transcript panel. */
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
   * In Tauri this goes through the real Rust engine: ffprobe â†’ SQLite cache,
   * FFmpeg waveform, FFmpeg filmstrip, SQLite transcript. In the browser it
   * falls back to the media baked by `tools/generate-media.mjs`.
   *
   * On the desktop there is never a mock transcript: the app opens the project
   * the user last worked on, and only when there is none does it fall back to
   * the demo recording - and only if that file is really on disk.
   */
  async init() {
    try {
      if (isTauri()) {
        const db = await defaultDbPath();

        // 1. The project the user last worked on: the real file, with the
        //    transcript already sitting in SQLite. No API call, no mock lines.
        const resumed = await resumeProject(db).catch(() => null);
        if (resumed) {
          // Resume is not an edit: `touch: false` keeps the stored clock, so
          // start-up alone never claims "Edited just now".
          await this.loadFromBackend(resumed, { touch: false });
          return;
        }

        // 2. First run: the demo recording, but only if it is really on disk.
        const demo = await demoSourcePath();
        if (demo) {
          await this.loadFromBackend(demo, { touch: false });
          return;
        }

        // 3. Nothing on disk: an empty editor, not an invented transcript.
        this.ready = true;
        return;
      }
      await this.loadBaked();
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : String(e);
      this.ready = true;
    }
  }

  private async loadBaked() {
    this.resetEditState();
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
    this.restoreUiState();
    this.ready = true;
  }

  /**
   * Real engine path: probe, waveform, filmstrip, transcript (SQLite).
   *
   * `touch` marks the project as opened *now* — true for a deliberate open or
   * import, false for the silent resume at start-up (which would otherwise
   * stamp "Edited just now" on a video the user never touched this session).
   */
  async loadFromBackend(path: string, opts: { touch?: boolean } = {}) {
    const touch = opts.touch !== false;

    // Whatever the previous project still has pending must be written under
    // ITS path before this session switches files — and the timer must be
    // cancelled, or it would later write these lines under the new one.
    await this.flush();
    this.resetEditState();

    // One spelling for the file, so the SQLite key is the same whatever the
    // working directory was when the app was launched.
    const canonical = await canonicalSourcePath(path).catch(() => path);
    const info = await probeMedia(canonical);
    this.media = {
      id: crypto.randomUUID(),
      name: canonical.split(/[\\/]/).pop() ?? 'video',
      url: assetUrl(canonical),
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
    this.sourcePath = canonical;
    setSourcePath(canonical);

    // A rename lives in SQLite, not in the filename: take the stored name when
    // a row exists for this file, so reopening cannot wipe a custom rename —
    // and stamp "opened now" only for a deliberate open, never for a resume.
    const stored = await this.storedProject(canonical);
    if (stored?.row?.name) this.name = stored.row.name;
    if (touch && stored?.row) {
      try {
        await updateProjectOpened(stored.db, canonical, Math.floor(Date.now() / 1000));
      } catch {
        /* the clock is a nicety, never a blocker */
      }
    }

    // Make sure the source is in the library too, so its media tile (and the
    // menu on it) exists.
    if (!media.byPath(canonical)) {
      const entry = media.addPath(canonical, this.media.name, info.sizeBytes);
      media.probed(entry.asset.id, {
        durationSecs: info.durationSecs,
        width: info.width ?? 0,
        height: info.height ?? 0,
        fps: info.fps ?? 0,
        sizeBytes: info.sizeBytes,
        videoCodec: info.videoCodec ?? 'unknown',
        audioCodec: info.audioCodec,
        durationLabel: `${Math.floor(info.durationSecs / 60)}:${String(
          Math.floor(info.durationSecs % 60)
        ).padStart(2, '0')}`
      });
    }

    const [wave, thumbs] = await Promise.all([
      extractWaveform(canonical).catch(() => null),
      extractThumbnails(canonical).catch(() => null)
    ]);
    if (wave) this.waveform = wave;
    if (thumbs) this.thumbnails = thumbs;

    try {
      this.lines = await this.ensureTranscript(canonical, info.durationSecs);
      this.loadError = null;
    } catch (e) {
      // No mock lines here. On the desktop the user gets the real reason the
      // transcript could not be produced, and a retry.
      this.loadError = e instanceof Error ? e.message : String(e);
      this.lines = [];
    }
    this.restoreUiState();

    // Remember the project, so the next launch opens this very file. The clock
    // stays honest: a resume keeps the old stamp, an open/import gets "now".
    void this.rememberProject(
      canonical,
      info.durationSecs,
      touch ? undefined : stored?.row?.lastOpened
    );

    this.ready = true;
  }

  /**
   * Write this project to the `projects` table (most-recently-opened wins).
   *
   * `openedAt` lets a caller keep an existing clock — the start-up resume
   * passes the stored value so it does not fake a fresh edit.
   */
  private async rememberProject(path: string, durationSecs: number, openedAt?: number) {
    try {
      const db = await defaultDbPath();
      await saveProject(
        db,
        crypto.randomUUID(),
        this.name || path.split(/[\\/]/).pop() || 'project',
        path,
        durationSecs,
        openedAt ?? Math.floor(Date.now() / 1000)
      );
    } catch {
      /* the project list is a convenience, never a blocker */
    }
  }

  /** The `projects` row for a source: the stored rename and the edit clock. */
  private async storedProject(path: string): Promise<{ db: string; row?: RustProject } | null> {
    if (!isTauri()) return null;
    try {
      const db = await defaultDbPath();
      const row = (await loadProjects(db)).find((p) => p.sourcePath === path);
      return { db, row };
    } catch {
      return null;
    }
  }

  /**
   * Rename the project and keep it in SQLite — the dashboard reads the name
   * from the `projects` table, so an in-memory rename would vanish on reload.
   */
  async rename(name: string): Promise<void> {
    const next = name.trim();
    if (!next) return;
    const previous = this.name;
    this.name = next;
    if (!isTauri() || !this.sourcePath) return;
    try {
      const db = await defaultDbPath();
      const row = (await loadProjects(db)).find((p) => p.sourcePath === this.sourcePath);
      await saveProject(
        db,
        row?.id ?? crypto.randomUUID(),
        next,
        this.sourcePath,
        row?.durationSecs ?? this.media?.durationSecs ?? 0,
        // A rename keeps the edit clock: it changes the label, not the work.
        row?.lastOpened ?? Math.floor(Date.now() / 1000)
      );
      logEditAction(next, 'rename', { from: previous, to: next });
    } catch (e) {
      /* the name is right for this session even if the write failed */
      logAppEvent('error', 'rename', String(e));
    }
  }

  /** Live pipeline state, shown in the Media mode while the cloud works. */
  pipeline = $state<{ stage: string; fraction: number } | null>(null);

  /**
   * The transcript for a source â€” **SQLite first, cloud only on a miss**.
   *
   * The rule that matters: the API is called **once**, when the user imports a
   * clip. The result is written to the `transcripts` table, and every later
   * session reads it straight off the disk. Re-opening a project never touches
   * the network.
   */
  async ensureTranscript(sourcePath: string, durationSecs: number): Promise<TranscriptLine[]> {
    const db = await defaultDbPath();

    // 1. SQLite cache â€” the common path, no network at all.
    const cached = await loadTranscript(db, sourcePath).catch(() => []);
    if (cached?.length) {
      this.pipeline = null;
      return cached.map((l) => ({
        id: l.id,
        startSec: l.startSecs,
        endSec: l.endSecs,
        text: l.text,
        flag: toLineFlag(l.flag),
        keep: l.keep ? 'keep' : 'cut',
        confidence: 1,
        words: l.words?.map((w) => ({ word: w.word, start: w.start, end: w.end }))
      }));
    }

    // 2. First time for this source: run the pipeline once, then persist.
    this.pipeline = { stage: 'Splitting audioâ€¦', fraction: 0.05 };
    const chunks = await extractAudioChunks(sourcePath);

    this.pipeline = { stage: 'Whisper transcribingâ€¦', fraction: 0.2 };
    let segs = await runTranscription(sourcePath, chunks, (stage, fraction) => {
      this.pipeline = { stage, fraction: 0.2 + fraction * 0.55 };
    });

    this.pipeline = { stage: 'Autocorrectingâ€¦', fraction: 0.8 };
    segs = await runCorrection(sourcePath, segs);

    this.pipeline = { stage: 'Gemini flagging fumblesâ€¦', fraction: 0.9 };
    segs = await runAnalysis(sourcePath, segs);

    this.pipeline = { stage: 'Saving to SQLiteâ€¦', fraction: 0.97 };
    await saveTranscript(
      db,
      sourcePath,
      segs.map((s) => ({
        id: s.id,
        startSecs: s.start_secs,
        endSecs: s.end_secs,
        text: s.text,
        keep: s.keep,
        flag: s.flag,
        originalText: s.original_text ?? '',
        // Word timings ride along, so a split can cut the *text* too.
        words: s.words
      }))
    );

    this.pipeline = null;
    return segs.map((s) => ({
      id: s.id,
      startSec: s.start_secs,
      endSec: s.end_secs,
      text: s.text,
      flag: toLineFlag(s.flag),
      keep: s.keep ? 'keep' : 'cut',
      confidence: 1,
      words: s.words?.map((w) => ({ word: w.word, start: w.start, end: w.end }))
    }));
  }

  /**
   * Find the silent spans in the source. Clipchamp's AI auto-cut scans for
   * pauses longer than three seconds â€” that is the default here too.
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
   * Auto-cut silence â€” Clipchamp's "AI suggestions / remove silences".
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
      // Progress trail: one row per real save (fires at most once per
      // debounced burst — never per keystroke).
      logEditAction(this.name || path, 'autosave', {
        lines: this.lines.length,
        cut: this.cutCount,
        kept: this.keptCount
      });
      return true;
    } catch (e) {
      logAppEvent('error', 'persist', String(e));
      return false;
    }
  }

  /** Pending debounced write — `null` when nothing is dirty. */
  private autosave: ReturnType<typeof setTimeout> | null = null;

  /**
   * Text clips, clip mutes, track hides and the user's segment order are UI
   * state, not transcript rows. They live in localStorage (small, synchronous,
   * no extra SQLite schema): the transcript itself stays in SQLite on disk.
   */
  private uiStateKey(): string | null {
    const id = this.sourcePath ?? this.media?.name;
    return id ? `t9.timelineUi:${id}` : null;
  }

  private saveUiState() {
    const key = this.uiStateKey();
    if (!key) return;
    try {
      const payload = {
        texts: this.texts,
        segmentOrder: this.segmentOrder,
        splitMarks: this.splitMarks,
        mutedSegments: this.mutedSegments,
        hiddenTracks: this.hiddenTracks
      };
      localStorage.setItem(key, JSON.stringify(payload));
    } catch {
      /* private mode / quota — the edit still works for this session */
    }
  }

  private restoreUiState() {
    const key = this.uiStateKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw) as {
        texts?: TextClip[];
        segmentOrder?: string[];
        splitMarks?: number[];
        mutedSegments?: string[];
        hiddenTracks?: TrackId[];
      };
      if (Array.isArray(data.texts)) {
        this.texts = data.texts
          .filter(
            (t) =>
              t &&
              typeof t.id === 'string' &&
              typeof t.text === 'string' &&
              typeof t.startSec === 'number' &&
              typeof t.endSec === 'number' &&
              t.endSec > t.startSec
          )
          .map((t) => ({
            id: t.id,
            text: t.text,
            startSec: t.startSec,
            endSec: t.endSec,
            kind: t.kind === 'title' || t.kind === 'code-zoom' ? t.kind : 'heading',
            hidden: t.hidden === true
          }));
      }
      if (Array.isArray(data.segmentOrder)) {
        this.segmentOrder = data.segmentOrder.filter((x) => typeof x === 'string');
      }
      if (Array.isArray(data.splitMarks)) {
        this.splitMarks = data.splitMarks
          .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
          .sort((a, b) => a - b);
      }
      if (Array.isArray(data.mutedSegments)) {
        this.mutedSegments = data.mutedSegments.filter((x) => typeof x === 'string');
      }
      if (Array.isArray(data.hiddenTracks)) {
        this.hiddenTracks = data.hiddenTracks.filter(
          (x): x is TrackId => x === 'text' || x === 'video' || x === 'audio'
        );
      }
    } catch {
      /* corrupt entry — start clean rather than block the project */
    }
  }

  /** Switching files must not leak the previous project's text or order. */
  private resetEditState() {
    this.lines = [];
    this.texts = [];
    this.waveform = null;
    this.thumbnails = null;
    this.cursor = 0;
    this.selectedIds = [];
    this.selectedTextId = null;
    this.clipboard = null;
    this.segmentOrder = [];
    this.splitMarks = [];
    this.mutedSegments = [];
    this.hiddenTracks = [];
    this.past = [];
    this.future = [];
    this.splitSeq = 0;
  }

  private scheduleAutosave() {
    if (this.autosave !== null) clearTimeout(this.autosave);
    this.autosave = setTimeout(() => {
      this.autosave = null;
      // Save UI state *after* the edit that scheduled this timer, otherwise
      // localStorage trails the mutation by one action.
      this.saveUiState();
      if (!isTauri()) return;
      void this.persist();
      void this.touchEdited();
    }, 750);
  }

  /** Write a pending edit straight away — before the dashboard reloads. */
  async flush() {
    this.saveUiState();
    if (this.autosave === null) return;
    clearTimeout(this.autosave);
    this.autosave = null;
    await this.persist();
    await this.touchEdited();
  }

  /** Stamp the project's last-edited time in SQLite (the "Edited …" label). */
  private async touchEdited() {
    const path = this.sourcePath;
    if (!path || !isTauri()) return;
    try {
      const db = await defaultDbPath();
      await updateProjectOpened(db, path, Math.floor(Date.now() / 1000));
    } catch {
      /* the clock is a nicety, never a blocker */
    }
  }

  /** Merged [start, end] ranges to skip â€” this is the Phantom Cut. */
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

  /** Merged ranges that survive the cut â€” these become the clips on the video lane. */
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
   * reorders those lines in the transcript panel â€” live.
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

  /** Source time â†’ position on the edit timeline (null when inside a cut). */
  editTimeAt = (sourceSec: number): number | null =>
    editTimeAt(this.orderedSegments, this.segmentOffsets, sourceSec);

  /** Position on the edit timeline â†’ source time (null when past the end). */
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
   * Phantom Cut â€” returns the corrected playback time if `sec` falls inside a cut range.
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
      // a browser blob â€” no engine, just the streamed file
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
   * project â€” bringing a new file in while editing starts a new project, which
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

  /**
   * User-dropped files in the **browser** (no filesystem path behind them).
   *
   * The desktop never comes here: Tauri's own drag-drop event hands over the
   * real path, which is what `importPaths` needs. A blob cannot be probed by
   * FFmpeg or stored in SQLite, so importing one on the desktop would only
   * ever produce a fake asset.
   */
  async importDropped(files: File[]) {
    await this.importBlobs(files);
  }

  /** User-dropped files must not navigate the window away. */
  private snapshot(): Snapshot {
    // Plain object copies — `structuredClone` cannot clone Svelte's reactive
    // proxies, and every field we keep here is a primitive or an array.
    return {
      lines: this.lines.map((l) => ({ ...l })),
      texts: this.texts.map((t) => ({ ...t })),
      segmentOrder: [...this.segmentOrder],
      splitMarks: [...this.splitMarks],
      mutedSegments: [...this.mutedSegments],
      hiddenTracks: [...this.hiddenTracks]
    };
  }

  private apply(snap: Snapshot) {
    this.lines = snap.lines.map((l) => ({ ...l }));
    this.texts = snap.texts.map((t) => ({ ...t }));
    this.segmentOrder = [...snap.segmentOrder];
    this.splitMarks = [...snap.splitMarks];
    this.mutedSegments = [...snap.mutedSegments];
    this.hiddenTracks = [...snap.hiddenTracks];
    this.cursor = Math.max(0, Math.min(this.lines.length - 1, this.cursor));
    this.selectedIds = [];
    this.selectedTextId = null;
    this.scheduleAutosave();
  }

  private commit() {
    this.past.push(this.snapshot());
    if (this.past.length > 30) this.past.shift();
    this.future.length = 0;
    // Every mutating edit passes through here — the single place to save it.
    this.scheduleAutosave();
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
    this.selectedTextId = null;
    this.selectedIds = this.isSelected(id)
      ? this.selectedIds.filter((x) => x !== id)
      : [...this.selectedIds, id];
  }

  /** Replace or extend the transcript/clip selection in one go. */
  selectMany(ids: string[], additive = false) {
    this.selectedTextId = null;
    const next = additive ? [...this.selectedIds] : [];
    const seen = new Set(next);
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        next.push(id);
      }
    }
    this.selectedIds = next;
  }

  /** Ctrl-click: each line in `ids` flips, so a whole clip toggles together. */
  toggleMany(ids: string[]) {
    this.selectedTextId = null;
    const set = new Set(this.selectedIds);
    const allSelected = ids.every((id) => set.has(id));
    for (const id of ids) {
      if (allSelected) set.delete(id);
      else set.add(id);
    }
    this.selectedIds = [...set];
  }

  selectText(id: string | null) {
    this.selectedTextId = id;
    if (id) this.selectedIds = [];
  }

  clearTextSelection() {
    this.selectedTextId = null;
  }

  selectAll() {
    this.selectedTextId = null;
    this.selectedIds = this.lines.map((l) => l.id);
  }

  deselectAll() {
    this.selectedIds = [];
    this.selectedTextId = null;
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
    this.selectedTextId = null;
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
  /** Clipchamp: Z + â† / â†’  (trim the start of the item). */
  trimStart(delta: number) {
    const cur = this.lines[this.cursor];
    if (!cur) return;
    const next = Math.max(0, Math.min(cur.endSec - 0.3, cur.startSec + delta));
    if (Math.abs(next - cur.startSec) < 0.01) return;
    this.commit();
    this.lines = this.lines.map((l) => (l.id === cur.id ? { ...l, startSec: next } : l));
  }

  /** Clipchamp: C + â† / â†’  (trim the end of the item). */
  trimEnd(delta: number) {
    const cur = this.lines[this.cursor];
    if (!cur) return;
    const next = Math.max(cur.startSec + 0.3, cur.endSec + delta);
    if (Math.abs(next - cur.endSec) < 0.01) return;
    this.commit();
    this.lines = this.lines.map((l) => (l.id === cur.id ? { ...l, endSec: next } : l));
  }

  /* ------------------------------------------------------- edit timeline */
  isSegmentMuted = (id: string) => this.mutedSegments.includes(id);

  /** Speaker button on a clip — preview mutes this source range. */
  toggleSegmentMute(id: string) {
    this.commit();
    this.mutedSegments = this.isSegmentMuted(id)
      ? this.mutedSegments.filter((x) => x !== id)
      : [...this.mutedSegments, id];
  }

  isTrackHidden = (track: TrackId) => this.hiddenTracks.includes(track);

  toggleTrackHidden(track: TrackId) {
    this.commit();
    this.hiddenTracks = this.isTrackHidden(track)
      ? this.hiddenTracks.filter((x) => x !== track)
      : [...this.hiddenTracks, track];
  }

  /**
   * Delete whole clips. Marking every line `cut` is what closes the gap:
   * `buildSegments()` simply stops producing the segment, and every later
   * offset slides left automatically.
   */
  cutSegments(ids: string[]): number {
    const wanted = new Set(ids);
    const targets = this.segments.filter((s) => wanted.has(s.id)).flatMap((s) => s.lines);
    if (!targets.length) return 0;
    this.commit();
    const lineIds = new Set(targets.map((l) => l.id));
    this.lines = this.lines.map((l) =>
      lineIds.has(l.id) ? { ...l, keep: 'cut' as KeepState } : l
    );
    this.selectedIds = [];
    this.selectedTextId = null;
    this.segmentOrder = this.segmentOrder.filter((id) => !wanted.has(id));
    this.mutedSegments = this.mutedSegments.filter((id) => !wanted.has(id));
    return targets.length;
  }

  /** Keep order and mute state pointing at a clip whose id changes after a trim. */
  private remapSegmentId(oldId: string, newId: string) {
    if (oldId === newId) return;
    const remap = (ids: string[]) => {
      const out: string[] = [];
      for (const id of ids) {
        const next = id === oldId ? newId : id;
        if (!out.includes(next)) out.push(next);
      }
      return out;
    };
    this.segmentOrder = remap(this.segmentOrder);
    this.mutedSegments = remap(this.mutedSegments);
  }

  /**
   * Move a clip's **start** edge inward to `targetSec`, cutting any whole
   * transcript lines the edge sweeps past. Only inward trims are offered:
   * extending would require resurrecting source that is already cut.
   */
  trimSegmentStartTo(segId: string, targetSec: number): boolean {
    const seg = this.segments.find((s) => s.id === segId);
    if (!seg) return false;
    const target = Math.min(seg.endSec - 0.3, Math.max(seg.startSec + 0.02, targetSec));
    if (target <= seg.startSec + 0.01) return false;
    this.commit();
    const updates = new Map<string, Partial<TranscriptLine>>();
    for (const line of seg.lines) {
      if (target >= line.endSec - 0.05) {
        updates.set(line.id, { keep: 'cut' });
      } else {
        if (target > line.startSec) updates.set(line.id, { startSec: target });
        break;
      }
    }
    const survivors = new Set(
      seg.lines.filter((l) => updates.get(l.id)?.keep !== 'cut').map((l) => l.id)
    );
    this.lines = this.lines.map((l) => (updates.has(l.id) ? { ...l, ...updates.get(l.id) } : l));
    const next = this.segments.find((s) => s.lines.some((l) => survivors.has(l.id)));
    if (next) this.remapSegmentId(seg.id, next.id);
    return true;
  }

  /** Move a clip's **end** edge inward to `targetSec` (same rules as start). */
  trimSegmentEndTo(segId: string, targetSec: number): boolean {
    const seg = this.segments.find((s) => s.id === segId);
    if (!seg) return false;
    const target = Math.max(seg.startSec + 0.3, Math.min(seg.endSec - 0.02, targetSec));
    if (target >= seg.endSec - 0.01) return false;
    this.commit();
    const updates = new Map<string, Partial<TranscriptLine>>();
    for (const line of [...seg.lines].reverse()) {
      if (target <= line.startSec + 0.05) {
        updates.set(line.id, { keep: 'cut' });
      } else {
        if (target < line.endSec) updates.set(line.id, { endSec: target });
        break;
      }
    }
    this.lines = this.lines.map((l) => (updates.has(l.id) ? { ...l, ...updates.get(l.id) } : l));
    return true;
  }

  /* ------------------------------------------------------------- text lane */
  private clampText(startSec: number, endSec: number): [number, number] {
    const total = Math.max(0.3, this.editDuration);
    let s = Math.max(0, Math.min(total - 0.3, startSec));
    let e = Math.max(s + 0.3, Math.min(total, endSec));
    if (e - s < 0.3) e = Math.min(total, s + 0.3);
    s = Math.max(0, Math.min(s, e - 0.3));
    return [s, e];
  }

  addText(
    text: string,
    startSec: number,
    endSec: number,
    kind: TextClip['kind'] = 'heading'
  ): TextClip | null {
    const clean = text.trim();
    if (!clean) return null;
    const [s, e] = this.clampText(startSec, endSec);
    this.commit();
    const clip: TextClip = {
      id: `txt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      startSec: s,
      endSec: e,
      text: clean,
      kind
    };
    this.texts = [...this.texts, clip];
    this.selectedTextId = clip.id;
    this.selectedIds = [];
    return clip;
  }

  updateText(
    id: string,
    patch: Partial<Pick<TextClip, 'text' | 'kind' | 'startSec' | 'endSec' | 'hidden'>>
  ) {
    const cur = this.texts.find((t) => t.id === id);
    if (!cur) return;
    const next: TextClip = { ...cur, ...patch };
    if (patch.startSec !== undefined || patch.endSec !== undefined) {
      [next.startSec, next.endSec] = this.clampText(next.startSec, next.endSec);
    }
    if (!next.text.trim()) return;
    next.text = next.text.trim();
    this.commit();
    this.texts = this.texts.map((t) => (t.id === id ? next : t));
  }

  moveText(id: string, startSec: number, endSec: number) {
    const cur = this.texts.find((t) => t.id === id);
    if (!cur) return;
    const [s, e] = this.clampText(startSec, endSec);
    if (Math.abs(s - cur.startSec) < 0.01 && Math.abs(e - cur.endSec) < 0.01) return;
    this.commit();
    this.texts = this.texts.map((t) => (t.id === id ? { ...t, startSec: s, endSec: e } : t));
  }

  removeText(id: string) {
    if (!this.texts.some((t) => t.id === id)) return;
    this.commit();
    this.texts = this.texts.filter((t) => t.id !== id);
    if (this.selectedTextId === id) this.selectedTextId = null;
  }

  toggleTextHidden(id: string) {
    const cur = this.texts.find((t) => t.id === id);
    if (!cur) return;
    this.commit();
    this.texts = this.texts.map((t) => (t.id === id ? { ...t, hidden: !t.hidden } : t));
  }

  /** Clipchamp: X + â† / â†’  (move the item earlier / later). */
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

  /** Source seconds where the user split a line â€” drawn as dividers on the timeline. */
  splitMarks = $state<number[]>([]);

  /**
   * Split a transcript line in two (Clipchamp's âœ‚ / `S`).
   *
   * Targeting rules, in order:
   *   1. The playhead is strictly inside a line â†’ split that line at the playhead.
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
   * **Cut at the playhead** â€” the gesture the user actually performs: drop the
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
