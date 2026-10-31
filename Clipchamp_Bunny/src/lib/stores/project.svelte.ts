import type {
  KeepState,
  LineFlag,
  MediaAsset,
  ProjectClip,
  SilenceRange,
  ThumbnailStrip,
  TranscriptLine,
  WaveformData
} from '../types';
import { MOCK_LINES } from '../mock';
import { framePreset, type ProjectFrame } from '../project-frame';
import {
  buildSegments,
  type Segment,
  computeOffsets,
  dropIndex,
  editDuration as editDurationOf,
  editTimeAt,
  insertSlotAt,
  moveInOrder,
  orderLines,
  orderSegments,
  sourceAt,
  timelineDuration as timelineDurationOf
} from '../segments';
import { loadMediaInfo, loadThumbnails, loadWaveform } from '../media';
import { detectQualitySuggestions, type QualitySuggestion } from '../suggestions';
import { media } from './media.svelte';
import { player } from './player.svelte';
import { runAnalysis, runCorrection, runTranscription, toLineFlag } from '../pipeline';
import { settings } from './settings.svelte';
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
  setSourceUrl,
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
  segmentOrder: string[];
  splitMarks: number[];
  cutSpans: Array<[number, number]>;
  mutedSegments: string[];
  segmentVolume: Record<string, number>;
  hiddenTracks: TrackId[];
}

export type TrackId = 'video' | 'audio';

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

/**
 * Read cut spans back out of JSON (localStorage / an undo snapshot).
 *
 * `JSON.parse` hands back `number[][]`, not tuples, and a corrupted entry
 * must not be able to poison the timeline — anything that is not a real
 * forward range is dropped.
 */
function toCutSpans(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  const out: Array<[number, number]> = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length < 2) continue;
    const a = Number(raw[0]);
    const b = Number(raw[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) out.push([a, b]);
  }
  return out;
}

/** Take `[a, b]` out of a span list, keeping the parts either side. */
function subtractSpan(
  spans: ReadonlyArray<readonly [number, number]>,
  a: number,
  b: number
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [x, y] of spans) {
    if (y <= a || x >= b) {
      out.push([x, y]);
      continue;
    }
    if (x < a) out.push([x, a]);
    if (y > b) out.push([b, y]);
  }
  return out;
}

/** Sort and weld overlapping/adjacent cut spans into a canonical list. */
function weldSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * What a file is, from its name — the timeline needs this before the engine
 * has probed anything, and an image has no duration of its own.
 */
export function clipKind(name: string, url = ''): ProjectClip['kind'] {
  const ext = (name || url).split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(ext)) return 'image';
  return 'video';
}

/**
 * Audio-only files are not timeline clips: the sequence is a video, and a
 * part with no picture cannot be joined with the rest. They still import into
 * My media (so the audio-only export can use them).
 */
export function isAudioOnly(name: string, url = ''): boolean {
  const ext = (name || url).split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? '';
  return ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'].includes(ext);
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
  /**
   * The transcript rows — **non-deep reactive** on purpose.
   *
   * `$state.raw` skips per-field proxies on what is usually thousands of
   * objects (a 4 000-line interview ≈ hundreds of MB of handler churn on
   * this 8 GB box). The store only ever *replaces* the array (map/slice/
   * spread), never mutating a row in place, so granular reactivity is not
   * needed: swapping the array triggers the same `$$tracked` reads.
   */
  lines = $state.raw<TranscriptLine[]>([]);
  /**
   * Extra clips appended after the main cut — the rest of the project's media.
   *
   * The main source is **not** in this list: it owns the transcript, waveform
   * and filmstrip, and every edit control keeps working on it exactly as
   * before. Extras are played and exported as-is, in the order added.
   *
   * This is what "one project, many assets" means here: a list of references
   * (path + in/out), never file bytes.
   */
  clips = $state<ProjectClip[]>([]);
  /** Which clip the preview shows: `null` means the main source. */
  activeClipId = $state<string | null>(null);
  /** Clip ids whose audio is muted (Clipchamp's speaker button on the clip). */
  mutedSegments = $state<string[]>([]);
  /**
   * Per-clip playback gain, 1 = original. Absent means 1.
   *
   * The sketch of the timeline asks for "mute/volume too because new clip"
   * (docs/TIMELINE_HUMAN_DIAGRAM.md): each clip is its own strip, so it owns
   * its own loudness. Nothing is re-encoded - this is a number in state, like
   * the cut flags, and the `<video>` element applies it in the preview.
   */
  segmentVolume = $state<Record<string, number>>({});
  /** Whole tracks hidden by the eye/Hide control. */
  hiddenTracks = $state<TrackId[]>([]);
  /**
   * Waveform peaks and the filmstrip — also raw. Both are single payloads the
   * extractor hands over wholesale; nothing mutates a bar or a frame in place.
   */
  waveform = $state.raw<WaveformData | null>(null);
  thumbnails = $state.raw<ThumbnailStrip | null>(null);
  /**
   * True while FFmpeg is still building this project's derived media.
   *
   * A first import decodes the whole file twice (audio for the peaks, video for
   * the filmstrip), which on a slow disk is tens of seconds — and an empty lane
   * with no explanation reads as "broken". The lanes say "Building…" instead.
   */
  waveformLoading = $state(false);
  thumbLoading = $state(false);
  /** Why a lane stayed empty. Shown in the lane, never swallowed. */
  waveformError = $state<string | null>(null);
  thumbError = $state<string | null>(null);
  /**
   * Peaks for the extra clips, keyed by **source path**.
   *
   * The main source has `waveform`; an extra clip is a different file with its
   * own audio, so its lane stayed empty until this existed. Keyed by path
   * because two clips cut from one file share exactly one waveform.
   */
  clipPeaks = $state.raw<Record<string, number[]>>({});
  /** Paths whose peaks are being fetched — one request per source file. */
  private clipPeaksInFlight = new Set<string>();

  /** Index of the transcript line the keyboard cursor sits on. */
  cursor = $state(0);

  /** Multi-selection (Clipchamp: Ctrl+A / Esc / TAB+ENTER). */
  selectedIds = $state<string[]>([]);

  /** Clipboard for Ctrl+C / Ctrl+V. */
  clipboard = $state<TranscriptLine | null>(null);

  /** Magnet: playhead snaps to line boundaries when true. */
  snap = $state(true);

  /** Right-rail CC toggle â€” hides/shows the transcript panel. */
  showTranscript = $state(false);

  /** Monotonic counter so every split produces unique line ids. */
  private splitSeq = 0;

  past = $state<Snapshot[]>([]);
  future = $state<Snapshot[]>([]);

  /** True until the real media has been probed. */
  ready = $state(false);
  loadError = $state<string | null>(null);

  /** Filesystem path of the source, when running under Tauri. */
  sourcePath = $state<string | null>(null);

  /**
   * The project's shape — the format card chosen when it was created.
   *
   * `16:9` means "keep the source's own frame"; every other ratio is a real
   * export canvas (see `project-frame.ts`). It is remembered per source path,
   * because a ratio belongs to *this project*, not to the app: opening a
   * vertical project must not turn the next horizontal one vertical.
   */
  frame = $state<ProjectFrame>('16:9');

  /** The canvas the exporter should render onto, or `null` for the source shape. */
  get canvasFrame(): [number, number] | null {
    return framePreset(this.frame).canvas;
  }

  /**
   * Name and ratio chosen in "Create New Project", before any file is loaded.
   *
   * The first file that arrives must not replace them with its own filename —
   * the user named this project on purpose.
   */
  private pendingName: string | null = null;
  private pendingFrame: ProjectFrame | null = null;

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

  /**
   * Load the baked demo media - the browser's stand-in for the engine.
   *
   * Public because the dashboard needs it too: in the browser a card click
   * has to open *something*, and the Rust engine that would probe a real
   * file is not there.
   */
  async loadBaked() {
    this.resetEditState();
    const [baked, waveform, thumbnails] = await Promise.all([
      loadMediaInfo(),
      loadWaveform(),
      loadThumbnails()
    ]);
    // The library belongs to the project that is open. The browser's baked
    // recording is this project, so its URL is the scope: no other project's
    // media can be shown here.
    media.enterScope(baked.url);
    this.media = baked;
    this.name = baked.name.replace(/\.[^.]+$/, '');
    // The panel's chosen name / shape win over the demo's own, so the browser
    // preview behaves like the desktop app for a project created a moment ago.
    if (this.pendingName) {
      this.name = this.pendingName;
      this.pendingName = null;
    }
    // No pending shape means this demo is its own project: 16:9, not whatever
    // the previous project happened to be.
    this.frame = this.pendingFrame ?? '16:9';
    this.pendingFrame = null;
    // The browser has no path — the dev server's export endpoint reads the
    // baked asset by its URL.
    setSourceUrl(baked.url);
    this.waveform = waveform;
    this.thumbnails = thumbnails;
    this.lines = scaleLines(MOCK_LINES, baked.durationSecs);
    // The library shows the media this project is made of. The desktop does
    // this in `loadFromBackend`; without it the browser's "My media" panel
    // was empty while the timeline showed the very same recording.
    if (!media.byPath(baked.url)) {
      const entry = media.addPath(baked.url, baked.name, baked.sizeBytes, baked.url);
      media.probed(entry.asset.id, {
        url: baked.url,
        durationSecs: baked.durationSecs,
        width: baked.width,
        height: baked.height,
        fps: baked.fps,
        sizeBytes: baked.sizeBytes,
        videoCodec: baked.videoCodec,
        audioCodec: baked.audioCodec,
        sampleRate: baked.sampleRate,
        channels: baked.channels,
        durationLabel: `${Math.floor(baked.durationSecs / 60)}:${String(
          Math.floor(baked.durationSecs % 60)
        ).padStart(2, '0')}`
      });
    }
    const bakedEntry = media.byPath(baked.url);
    if (bakedEntry) media.focusSource(bakedEntry.asset.id);
    this.restoreClips();
    this.restoreUiState();
    this.restorePlayhead();
    this.ready = true;
  }

  /**
   * A project that does not exist yet: the Create Project panel already knows
   * its name and shape.
   *
   * They are held as *pending* until a file arrives, because a project with no
   * media has nothing to write to SQLite — and the first import would otherwise
   * rename the project after the file the user happened to pick.
   */
  applyNewProject(name: string, frame: ProjectFrame): void {
    const next = name.trim();
    this.pendingName = next || null;
    this.pendingFrame = frame;
    this.frame = frame;
    if (next) this.name = next;
  }

  /** Forget a name/ratio that was waiting for a file that never arrived. */
  discardPending(): void {
    this.pendingName = null;
    this.pendingFrame = null;
  }

  /**
   * Start from nothing — the Create Project panel's promise of a *new* project.
   *
   * Without this, "New project → This PC" on a machine that already had a
   * project open would import into that project's library instead of opening
   * the file the user just chose. The old project is flushed to SQLite first,
   * exactly like `loadFromBackend` does before it switches files.
   */
  async startNew(name: string, frame: ProjectFrame): Promise<void> {
    await this.flush();
    this.resetEditState();
    this.media = null;
    this.sourcePath = null;
    this.loadError = null;
    this.ready = false;
    this.name = '';
    // A new project starts with an empty **My media**: the previous project's
    // imports belong to the previous project. This is the whole reason the
    // panel used to show "old media" after New project.
    media.startDraft();
    this.applyNewProject(name, frame);
  }

  /** Change the shape of the open project, and remember it for this file. */
  setFrame(frame: ProjectFrame): void {
    this.frame = frame;
    this.pendingFrame = frame;
    this.writeFrame(frame);
  }

  /** localStorage key for one project's shape. */
  private frameKey(path: string): string {
    return `t9-editor-lit.frame.${path}`;
  }

  private readFrame(path: string): ProjectFrame | null {
    try {
      const raw = localStorage.getItem(this.frameKey(path));
      return raw && framePreset(raw).id === raw ? (raw as ProjectFrame) : null;
    } catch {
      return null;
    }
  }

  private writeFrame(frame: ProjectFrame): void {
    const path = this.sourcePath;
    if (!path) return;
    try {
      localStorage.setItem(this.frameKey(path), frame);
    } catch {
      /* private mode — the shape just is not remembered */
    }
  }

  /**
   * Real engine path: probe, waveform, filmstrip, transcript (SQLite).
   *
   * `touch` marks the project as opened *now* — true for a deliberate open or
   * import, false for the silent resume at start-up (which would otherwise
   * stamp "Edited just now" on a video the user never touched this session).
   */
  async loadFromBackend(path: string, opts: { touch?: boolean; carryDraft?: boolean } = {}) {
    const touch = opts.touch !== false;

    // Whatever the previous project still has pending must be written under
    // ITS path before this session switches files — and the timer must be
    // cancelled, or it would later write these lines under the new one.
    await this.flush();
    this.resetEditState();

    // One spelling for the file, so the SQLite key is the same whatever the
    // working directory was when the app was launched.
    const canonical = await canonicalSourcePath(path).catch(() => path);
    // Switch the library with the project *before* the (slow) probe: otherwise
    // the editor would show the previous project's media while a 5 GB file is
    // being read, and could leave it there if the probe fails.
    // `carryDraft` is for the case where a draft (new project, no source yet)
    // just got this file dropped on it: the imports in it belong to this
    // project, so they are kept.
    media.enterScope(canonical, { carryDraft: opts.carryDraft });
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
    setSourceUrl(this.media.url);

    // A rename lives in SQLite, not in the filename: take the stored name when
    // a row exists for this file, so reopening cannot wipe a custom rename —
    // and stamp "opened now" only for a deliberate open, never for a resume.
    const stored = await this.storedProject(canonical);
    if (stored?.row?.name) this.name = stored.row.name;
    // A project created from the panel keeps the name the user typed, and the
    // shape they picked, even though neither has been written anywhere yet.
    if (this.pendingName) {
      this.name = this.pendingName;
      this.pendingName = null;
    }
    const storedFrame = this.readFrame(canonical);
    this.frame = this.pendingFrame ?? storedFrame ?? '16:9';
    this.pendingFrame = null;
    this.writeFrame(this.frame);
    if (touch && stored?.row) {
      try {
        await updateProjectOpened(stored.db, canonical, Math.floor(Date.now() / 1000));
      } catch {
        /* the clock is a nicety, never a blocker */
      }
    }

    // Make sure the source is in the library too, so its media tile (and the
    // menu on it) exists. An import already registered a bare entry (path +
    // name, no URL yet), so patch that one instead of skipping it - otherwise
    // a freshly imported file would keep a URL-less tile and look blank.
    const existing = media.byPath(canonical);
    const entry =
      existing ?? media.addPath(canonical, this.media.name, info.sizeBytes, this.media.url);
    media.probed(entry.asset.id, {
      url: this.media.url,
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
    // One project, one "current" tile — restored entries start unused.
    media.focusSource(entry.asset.id);

    // A first import decodes the file twice. Say so in the lanes instead of
    // showing two black strips that look broken, and keep the reason when a
    // lane really cannot be built (a picture, a file with no audio track).
    this.waveformLoading = true;
    this.thumbLoading = true;
    this.waveformError = null;
    this.thumbError = null;
    const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const [wave, thumbs] = await Promise.all([
      extractWaveform(canonical)
        .catch((e) => {
          this.waveformError = reason(e);
          return null;
        })
        .finally(() => (this.waveformLoading = false)),
      extractThumbnails(canonical)
        .catch((e) => {
          this.thumbError = reason(e);
          return null;
        })
        .finally(() => (this.thumbLoading = false))
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
    this.restoreClips();
    this.restoreUiState();
    this.restorePlayhead();

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

  /** Live pipeline state, shown in the transcript panel while the cloud works. */
  pipeline = $state<{ stage: string; fraction: number } | null>(null);

  /**
   * The transcript for a source â€” **SQLite first, cloud only on a miss**.
   *
   * The rule that matters: the cloud API is **never** called behind the user's
   * back. On a cache miss this returns nothing unless `settings.autoTranscribe`
   * is on; the transcript panel's button is the manual path either way. The
   * result is written to the `transcripts` table, so every later session reads
   * it straight off the disk and the network is paid once per source, not per
   * open. Re-opening a project never touches the network.
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

    // 2. No cache, and the user has not asked for a transcript: stop here.
    //    A plain cut project must never spend an API call on its own.
    if (!settings.autoTranscribe) {
      this.pipeline = null;
      return [];
    }

    // 3. First time for this source, with permission: run once, then persist.
    return this.runPipeline(sourcePath);
  }

  /**
   * Produce the transcript **because the user asked for it** — the button in
   * the transcript panel. Deliberately ignores the auto flag: the click *is*
   * the permission. The result is persisted like any other transcript, so the
   * next open of this source is served from SQLite and the cloud is not paid
   * twice.
   */
  async generateTranscript(): Promise<void> {
    if (this.pipeline) return;
    const source = this.sourcePath;
    if (!source) return;
    try {
      this.lines = await this.runPipeline(source);
      // Cuts made before any transcript existed still own their stretch.
      this.syncCutsIntoLines();
      this.loadError = null;
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : String(e);
      this.lines = [];
    }
  }

  /** The one cloud pass: split -> Whisper -> correct -> Gemini flags -> SQLite. */
  private async runPipeline(sourcePath: string): Promise<TranscriptLine[]> {
    const db = await defaultDbPath();
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
    if (!path || !isTauri()) {
      // The browser has no FFmpeg, so the scan is synthesized from the
      // transcript itself: real flagged silences first, then any ≥ minSecs
      // dead-air gap between kept lines, and — so the green preview stays
      // inspectable in the demo — a tail of the two longest kept lines. The
      // shape matches the desktop result exactly; the UI never special-cases.
      const keeps = this.lines.filter((l) => l.keep === 'keep');
      const spans: SilenceRange[] = [];
      for (const l of keeps) {
        if (l.flag === 'silence' && l.endSec - l.startSec >= minSecs)
          spans.push({ start: l.startSec, end: l.endSec });
      }
      const sorted = keeps.toSorted((a, b) => a.startSec - b.startSec);
      for (let i = 1; i < sorted.length; i++) {
        const to = sorted[i].startSec;
        const from = sorted[i - 1].endSec;
        // A gap whose span is already covered by a cut flagged line has
        // nothing to suggest (the mock marks its accepted silences that way);
        // only spans floating free of the transcript — true dead air — preview.
        if (to - from >= minSecs && !this.lines.some((l) => l.endSec > from && l.startSec < to))
          spans.push({ start: from, end: to });
      }
      if (!spans.length) {
        for (const l of keeps
          .toSorted((a, b) => b.endSec - b.startSec - (a.endSec - a.startSec))
          .slice(0, 2)) {
          const from = Math.max(
            l.startSec,
            l.endSec - Math.max(minSecs, (l.endSec - l.startSec) * 0.4)
          );
          if (l.endSec - from >= 1.2) spans.push({ start: from, end: l.endSec });
        }
      }
      return spans;
    }
    return detectSilence(path, -30, minSecs);
  }

  /** Mark every transcript line that overlaps one of the given spans as cut. */
  cutSilences(ranges: SilenceRange[]): number {
    if (!ranges.length) return 0;
    this.commit();
    // A fresh cut invalidates the green preview: the spans on screen are about
    // to become red, and a stale preview would paint a lie.
    this.suggestions = [];
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

  /** AI silence suggestions staged as a timeline preview. WaveTimeline paints
   *  them GREEN; nothing is cut until the user presses Apply. */
  suggestions = $state<SilenceRange[]>([]);

  /** Suggestions that are still meaningful — a staged span becomes stale only
   *  when a transcript line ALREADY cut covers it (the user cut it manually);
   *  spans that touch kept lines are live, and spans touching nothing at all
   *  (pure dead air between segments) are live too — cutting voids is the
   *  whole point of a silence suggestion. */
  liveSuggestions = $derived(
    this.suggestions.filter((r) => {
      let touchedAny = false;
      for (const l of this.lines) {
        if (l.endSec > r.start && l.startSec < r.end) {
          if (l.keep === 'keep') return true;
          touchedAny = true;
        }
      }
      return !touchedAny;
    })
  );

  /** Scan only — stage the green preview. */
  async suggestSilences(minSecs = 3.0): Promise<number> {
    const ranges = await this.findSilences(minSecs);
    this.suggestions = ranges;
    return ranges.length;
  }

  /** Turn the green preview into real cuts (undoable through history). */
  applySuggestions(): number {
    const n = this.cutSilences(this.suggestions);
    this.suggestions = [];
    return n;
  }

  /** Reject the green preview — the timeline keeps everything. */
  clearSuggestions() {
    this.suggestions = [];
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

  /**
   * The other half of the same product idea: a fumble or a second take leaves
   * no silence behind, so the waveform cannot see it. `suggestions.ts` reads
   * the transcript and stages the lines it believes are a mistake.
   *
   * Kept apart from `suggestions` (green silence spans) on purpose: the two
   * are different evidence, the UI paints them differently, and a staged line
   * is applied by **id**, never by overlap - a neighbour that merely touches
   * the edge must not be swept in.
   */
  qualitySuggestions = $state<QualitySuggestion[]>([]);

  /** Staged lines that are still worth cutting - applying or restoring a line
   *  drops it out of the preview instead of leaving a stale band behind. */
  liveQualitySuggestions = $derived(
    this.qualitySuggestions.filter((s) => {
      const line = this.lines.find((l) => l.id === s.lineId);
      return !!line && line.keep === 'keep';
    })
  );

  /** Scan only — stage the amber preview. Nothing is cut here. */
  suggestQuality(): number {
    const found = detectQualitySuggestions(this.lines);
    this.qualitySuggestions = found;
    return found.length;
  }

  /** Turn the amber preview into cuts, one transcript line at a time. */
  applyQualitySuggestions(): number {
    const ids = new Set(this.liveQualitySuggestions.map((s) => s.lineId));
    this.qualitySuggestions = [];
    if (!ids.size) return 0;
    this.commit();
    this.lines = this.lines.map((l) => (ids.has(l.id) ? { ...l, keep: 'cut' as KeepState } : l));
    return ids.size;
  }

  /** Reject the amber preview — the transcript keeps every word. */
  clearQualitySuggestions() {
    this.qualitySuggestions = [];
  }

  /** Persist the current transcript + cut decisions to SQLite. */
  async persist() {
    const path = this.sourcePath;
    if (!path || !isTauri()) return false;
    try {
      const db = await defaultDbPath();
      // Diff save: the engine writes only rows that actually differ and
      // returns how many. A tick where the user did not touch anything
      // writes zero rows instead of re-rolling the whole table.
      const written = await saveTranscript(
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
      // debounced burst — never per keystroke). `written` is the honest
      // "what changed" number, so a trail row never lies about work done.
      logEditAction(this.name || path, 'autosave', {
        lines: this.lines.length,
        written,
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
   * Clip mutes, track hides and the user's segment order are UI state, not
   * transcript rows. They live in localStorage (small, synchronous, no extra
   * SQLite schema): the transcript itself stays in SQLite on disk.
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
        segmentOrder: this.segmentOrder,
        splitMarks: this.splitMarks,
        cutSpans: this.cutSpans,
        mutedSegments: this.mutedSegments,
        segmentVolume: this.segmentVolume,
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
        segmentOrder?: string[];
        splitMarks?: number[];
        cutSpans?: unknown;
        mutedSegments?: string[];
        segmentVolume?: Record<string, number>;
        hiddenTracks?: TrackId[];
      };
      if (Array.isArray(data.segmentOrder)) {
        this.segmentOrder = data.segmentOrder.filter((x) => typeof x === 'string');
      }
      if (Array.isArray(data.splitMarks)) {
        this.splitMarks = data.splitMarks
          .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
          .sort((a, b) => a - b);
      }
      this.cutSpans = weldSpans(toCutSpans(data.cutSpans));
      this.syncCutsIntoLines();
      if (Array.isArray(data.mutedSegments)) {
        this.mutedSegments = data.mutedSegments.filter((x) => typeof x === 'string');
      }
      if (data.segmentVolume && typeof data.segmentVolume === 'object') {
        const map: Record<string, number> = {};
        for (const [id, v] of Object.entries(data.segmentVolume)) {
          if (typeof v === 'number' && Number.isFinite(v)) map[id] = Math.min(1, Math.max(0, v));
        }
        this.segmentVolume = map;
      }
      if (Array.isArray(data.hiddenTracks)) {
        this.hiddenTracks = data.hiddenTracks.filter(
          (x): x is TrackId => x === 'video' || x === 'audio'
        );
      }
    } catch {
      /* corrupt entry — start clean rather than block the project */
    }
  }

  /** LocalStorage key for the last playhead position (tiny, written often). */
  private playheadKey(): string | null {
    const id = this.sourcePath ?? this.media?.name;
    return id ? `t9.playhead:${id}` : null;
  }

  /**
   * Remember where the playhead was.
   *
   * A cut project used to reopen at the top of the sequence, which is confusing
   * once clips have been reordered: "the first clip" is no longer the beginning
   * of the recording the user remembers. The position is a tiny key of its own,
   * so the debounced 750 ms UI-state save does not have to run on every seek.
   */
  savePlayhead() {
    const key = this.playheadKey();
    if (!key) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ clipId: this.activeClipId, sec: player.currentTime })
      );
    } catch {
      /* private mode / quota — resuming is a nicety, never a blocker */
    }
  }

  /** Reopen at the exact place the editor was left, not the top of the strip. */
  private restorePlayhead() {
    const key = this.playheadKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw) as { clipId?: string | null; sec?: number };
      if (typeof data.sec !== 'number' || !Number.isFinite(data.sec)) return;
      const clip = data.clipId ? this.clips.find((c) => c.id === data.clipId) : null;
      if (clip) {
        this.activeClipId = clip.id;
        player.seek(Math.min(clip.outSec, Math.max(clip.inSec, data.sec)));
        return;
      }
      this.activeClipId = null;
      // A position that is now inside a cut would show cut material in the
      // applied preview; land on the nearest kept frame instead.
      let sec = this.isCutAt(data.sec) ? this.nearestKeptSource(data.sec) : data.sec;
      const dur = this.media?.durationSecs ?? 0;
      if (dur > 0) sec = Math.min(sec, Math.max(0, dur - 0.05));
      player.seek(Math.max(0, sec));
    } catch {
      /* corrupt entry — start at the top */
    }
  }

  /** Switching files must not leak the previous project's order or mutes. */
  private resetEditState() {
    this.lines = [];
    this.clips = [];
    this.activeClipId = null;
    this.waveform = null;
    this.thumbnails = null;
    this.waveformLoading = false;
    this.thumbLoading = false;
    this.waveformError = null;
    this.thumbError = null;
    this.clipPeaks = {};
    this.cursor = 0;
    this.selectedIds = [];
    this.clipboard = null;
    this.segmentOrder = [];
    this.splitMarks = [];
    this.cutSpans = [];
    this.mutedSegments = [];
    this.segmentVolume = {};
    this.hiddenTracks = [];
    this.past = [];
    this.future = [];
    this.splitSeq = 0;
    player.currentTime = 0;
    player.playing = false;
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

  /** Merged [start, end] ranges to skip — the cut blocks, in source order. */
  cutRanges = $derived.by(() => {
    const ranges: Array<[number, number]> = [];
    const cut = this.orderedSegments
      .filter((s) => s.state === 'cut')
      .sort((a, b) => a.startSec - b.startSec);
    for (const s of cut) {
      const last = ranges[ranges.length - 1];
      if (last && s.startSec - last[1] < 0.35) last[1] = Math.max(last[1], s.endSec);
      else ranges.push([s.startSec, s.endSec]);
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

  /** Source seconds where the user split at — each one forces a clip boundary. */
  splitMarks = $state<number[]>([]);

  /**
   * Source ranges the user cut where no transcript row covered them.
   *
   * With a transcript, a cut row already carries its own range; this list is
   * what makes a cut survive **before** any transcript exists — and stay red
   * even once one arrives and fails to cover that stretch.
   */
  cutSpans = $state<Array<[number, number]>>([]);

  segments = $derived(
    buildSegments(this.lines, {
      cutSpans: this.cutSpans,
      splitMarks: this.splitMarks,
      sourceDurationSec: this.durationSec
    })
  );

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

  /**
   * Total length of the **timeline strip** — cut blocks counted, because they
   * still occupy their width. This is the axis the bottom lane is drawn on.
   */
  timelineDuration = $derived(timelineDurationOf(this.orderedSegments));

  /** Is there anything at all left to put in the final video? */
  hasKeptContent = $derived(this.editDuration > 0);

  /** Source time â†’ position on the edit timeline (null when inside a cut). */
  editTimeAt = (sourceSec: number): number | null =>
    editTimeAt(this.orderedSegments, this.segmentOffsets, sourceSec);

  /** Position on the edit timeline â†’ source time (null when past the end). */
  sourceAt = (editSec: number): number | null =>
    sourceAt(this.orderedSegments, this.segmentOffsets, editSec);

  /* ------------------------------------------------------- project sequence
     The main cut is a sequence in its own right; extra clips are appended
     after it. Every global position on the bottom timeline goes through
     `sequenceAt` / `globalTimeAt`, so the playhead, the seek and the preview
     all agree about which clip a second belongs to. */

  /** The clip the preview is showing, or `null` for the main source. */
  get activeClip(): ProjectClip | null {
    return this.clips.find((c) => c.id === this.activeClipId) ?? null;
  }

  /** How long one extra clip lasts on the timeline. */
  clipLength(c: ProjectClip): number {
    return Math.max(0.1, c.outSec - c.inSec);
  }

  /**
   * Fetch an extra clip's waveform once, for its lane.
   *
   * Best-effort: an image, an unreadable file or the browser demo (no IPC)
   * simply leaves the lane flat — the clip still plays and still exports.
   */
  ensureClipPeaks(clip: ProjectClip) {
    if (clip.kind === 'image') return;
    const key = clip.path;
    if (this.clipPeaks[key] || this.clipPeaksInFlight.has(key)) return;
    this.clipPeaksInFlight.add(key);
    extractWaveform(key)
      .then((w) => {
        if (!w?.peaks?.length) return;
        this.clipPeaks = { ...this.clipPeaks, [key]: w.peaks };
      })
      .catch(() => {
        /* no audio track, unreadable file, or the browser demo */
      })
      .finally(() => this.clipPeaksInFlight.delete(key));
  }

  /** Total length of the extra clips. */
  get extrasDuration(): number {
    return this.clips.reduce((n, c) => n + this.clipLength(c), 0);
  }

  /** Where every extra clip sits on the bottom timeline. */
  extrasLayout = $derived.by(() => {
    const out: Array<{ clip: ProjectClip; start: number; end: number }> = [];
    // Extras live past the whole strip, cut blocks included — hiding a cut
    // must not slide the extra clips over red material.
    let at = this.timelineDuration;
    for (const clip of this.clips) {
      const end = at + this.clipLength(clip);
      out.push({ clip, start: at, end });
      at = end;
    }
    return out;
  });

  /** Whole project length: the whole strip plus every extra clip. */
  get sequenceDuration(): number {
    return this.timelineDuration + this.extrasDuration;
  }

  /**
   * A source second that lies inside a cut block, mapped to the nearest kept
   * source second. Clicking a red/grey block seeks to its edge, so playback
   * never lands on material that is not in the final video.
   */
  nearestKeptSource(sourceSec: number): number {
    let best: number | null = null;
    for (const s of this.orderedSegments) {
      if (s.state !== 'keep') continue;
      for (const edge of [s.startSec, s.endSec]) {
        if (best === null || Math.abs(edge - sourceSec) < Math.abs(best - sourceSec)) best = edge;
      }
    }
    return best ?? Math.max(0, sourceSec);
  }

  /** Bottom-timeline position maps to the clip that owns it (null = main). */
  sequenceAt(editSec: number): { clip: ProjectClip | null; localSec: number } | null {
    if (editSec < this.timelineDuration) {
      const raw = this.sourceAt(Math.max(0, editSec));
      if (raw == null) return null;
      // Applied mode snaps a click on a cut block to its edge; raw preview
      // lands *inside* the block, because watching cut material is the point.
      const inCut = !player.previewRaw && this.cutRanges.some(([a, b]) => raw >= a && raw < b);
      return { clip: null, localSec: inCut ? this.nearestKeptSource(raw) : raw };
    }
    for (const r of this.extrasLayout) {
      if (editSec < r.end) {
        return {
          clip: r.clip,
          localSec: r.clip.inSec + Math.max(0, editSec - r.start)
        };
      }
    }
    return null;
  }

  /** Where the playhead sits on the whole project timeline. */
  globalTimeAt(clipId: string | null, localSec: number): number {
    if (!clipId) {
      const at = this.editTimeAt(localSec);
      if (at != null) return at;
      // Inside a cut: hold the end of the segment the playhead has passed,
      // rather than snapping the marker to the start of the project.
      let last = 0;
      for (const s of this.orderedSegments) {
        if (s.startSec >= localSec) break;
        const off = this.segmentOffsets.get(s.id);
        if (off) last = off.start + Math.max(0, Math.min(localSec, s.endSec) - s.startSec);
      }
      return last;
    }
    const r = this.extrasLayout.find((x) => x.clip.id === clipId);
    if (!r) return 0;
    const inside = Math.min(Math.max(localSec - r.clip.inSec, 0), this.clipLength(r.clip));
    return r.start + inside;
  }

  /** Id of the clip after `activeClipId`, or null at the end of the project. */
  nextClipId(): string | null {
    if (!this.activeClipId) return this.clips[0]?.id ?? null;
    const i = this.clips.findIndex((c) => c.id === this.activeClipId);
    return this.clips[i + 1]?.id ?? null;
  }

  /** Show one clip in the preview (null = back to the main cut). */
  activateClip(id: string | null) {
    if ((this.activeClipId ?? null) === (id ?? null)) return;
    this.activeClipId = id;
    this.selectedIds = [];
    this.cursor = 0;
    if (id) {
      const clip = this.clips.find((c) => c.id === id);
      player.seek(clip?.inSec ?? 0);
    } else {
      // Back to the main cut: its first kept frame, not the top of the file.
      player.seek(this.sourceAt(0) ?? 0);
    }
  }

  /**
   * Move the playhead by `delta` seconds of the **visible timeline** (J / L).
   *
   * J / L used to step through *source* seconds. After a cut or a reorder that
   * is not the step the user chose: a 5 s press could cross a red block and
   * move 17 s on the strip, or land inside a cut and get flung to its edge.
   * The transport step is a step of the timeline the user is looking at, so the
   * conversion happens in sequence space and an extra clip is activated when
   * the target lands after the main cut.
   */
  stepSequenceBy(delta: number) {
    const clip = this.activeClip;
    if (clip) {
      // An extra clip has no cuts: a plain step clamped to its own in/out.
      player.seek(Math.min(clip.outSec, Math.max(clip.inSec, player.currentTime + delta)));
      return;
    }
    const from = this.globalTimeAt(null, player.currentTime);
    const end = Math.max(0, this.sequenceDuration - 0.05);
    const target = Math.min(Math.max(from + delta, 0), end);
    const at = this.sequenceAt(target);
    if (!at) return;
    this.activateClip(at.clip?.id ?? null);
    player.seek(at.localSec);
  }

  /**
   * Put a library asset on the timeline.
   *
   * This is the **only** door media takes onto the timeline: a drag, or the
   * tile's + button. Importing a file never calls this (see
   * `docs/MEDIA_LIBRARY_TIMELINE.md`).
   *
   * The first clip in a project that has no video yet **becomes the project's
   * source**, so the whole Cut pipeline (transcript, waveform, phantom cut)
   * has something to work on. Every later one is appended after the cut.
   */
  async placeAsset(assetId: string, atIndex?: number): Promise<'source' | 'clip' | 'blocked'> {
    const entry = media.get(assetId);
    if (!entry || entry.phase === 'loading') return 'blocked';
    if (isAudioOnly(entry.asset.name, entry.asset.url)) return 'blocked';

    if (!this.media) {
      try {
        await this.openLibraryEntry(assetId);
      } catch (e) {
        this.loadError = e instanceof Error ? e.message : String(e);
        return 'blocked';
      }
      return this.media ? 'source' : 'blocked';
    }

    const clip = this.addToTimeline(assetId, atIndex);
    if (!clip) return 'blocked';
    this.activateClip(clip.id);
    return 'clip';
  }

  /**
   * Where a new clip should be inserted for a pointer on the bottom timeline.
   *
   * The main cut is one source: a foreign video cannot be woven into its
   * transcript (that would need a multi-source render), so anywhere over it
   * means "before the first extra clip". Inside the extra strip the pointer
   * picks the gap between two clips, which is the Clipchamp gesture of
   * dropping a new clip *between* two existing ones.
   */
  insertIndexAt(editSec: number): number {
    return insertSlotAt(this.extrasLayout, editSec);
  }

  /**
   * Put a library asset on the timeline as an extra clip.
   *
   * `atIndex` is the slot the pointer was over (see `insertIndexAt`);
   * omitting it appends, which is what the + button does. Returns null when
   * the asset cannot be a clip (still probing, audio-only, or already on the
   * timeline as the main source).
   */
  addToTimeline(assetId: string, atIndex?: number): ProjectClip | null {
    const entry = media.get(assetId);
    if (!entry) return null;
    if (isAudioOnly(entry.asset.name, entry.asset.url)) return null;
    const kind = clipKind(entry.asset.name, entry.asset.url);
    // `inUse` is the library's stable "this tile is the open project" marker;
    // path equality misses once the URL has been normalised.
    if (entry.inUse) return null;
    if (entry.path && this.sourcePath && entry.path === this.sourcePath) return null;
    // The browser has no path; its equivalent identity is the streamed URL.
    if (this.media && entry.asset.url && entry.asset.url === this.media.url) return null;
    const duration = entry.asset.durationSecs || (kind === 'image' ? 5 : 0);
    if (entry.phase === 'loading' || duration <= 0) return null;
    const url = entry.asset.url || (entry.path ? assetUrl(entry.path) : '');
    if (!url) return null;

    const clip: ProjectClip = {
      id: crypto.randomUUID(),
      path: entry.path ?? url,
      url,
      name: entry.asset.name,
      kind,
      durationSecs: duration,
      inSec: 0,
      outSec: kind === 'image' ? Math.min(5, duration) || 5 : duration
    };
    const at =
      atIndex == null ? this.clips.length : Math.max(0, Math.min(this.clips.length, atIndex));
    this.clips = [...this.clips.slice(0, at), clip, ...this.clips.slice(at)];
    // The lane is drawn from the clip's own audio; without this the dropped
    // clip's waveform row stayed empty.
    this.ensureClipPeaks(clip);
    this.saveClips();
    return clip;
  }

  /** Take one clip off the timeline (the main cut cannot be removed). */
  removeClip(id: string) {
    const before = this.clips.length;
    this.clips = this.clips.filter((c) => c.id !== id);
    if (this.clips.length === before) return;
    if (this.activeClipId === id) {
      this.activeClipId = null;
      player.seek(this.sourceAt(0) ?? 0);
    }
    this.saveClips();
  }

  /** Reorder an extra clip. `delta` is -1 (left) / +1 (right). */
  moveClip(id: string, delta: number) {
    const i = this.clips.findIndex((c) => c.id === id);
    const to = i + delta;
    if (i < 0 || to < 0 || to >= this.clips.length) return;
    const next = [...this.clips];
    const [clip] = next.splice(i, 1);
    next.splice(to, 0, clip);
    this.clips = next;
    this.saveClips();
  }

  /* Extra clips are project state, not transcript rows: a short list of
     paths lives in localStorage, keyed by the project, so reopening the
     project brings its media back. The transcript itself stays in SQLite. */
  private clipsKey(): string | null {
    const id = this.sourcePath ?? this.media?.name;
    return id ? `t9.projectClips:${id}` : null;
  }

  private saveClips() {
    const key = this.clipsKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(this.clips));
    } catch {
      /* private mode / quota - the timeline still works this session */
    }
  }

  private restoreClips() {
    const key = this.clipsKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw) as ProjectClip[];
      if (!Array.isArray(data)) return;
      this.clips = data.filter(
        (c): c is ProjectClip =>
          !!c &&
          typeof c.id === 'string' &&
          typeof c.path === 'string' &&
          typeof c.url === 'string' &&
          typeof c.name === 'string' &&
          typeof c.durationSecs === 'number' &&
          typeof c.inSec === 'number' &&
          typeof c.outSec === 'number'
      );
      // Restored clips need their lanes too — this is the second visit to a
      // project, so the waveform comes from the on-disk cache.
      for (const c of this.clips) this.ensureClipPeaks(c);
    } catch {
      /* corrupt entry - start without extras rather than block the project */
    }
  }

  /** The clip that holds a given media path, if it is on the timeline. */
  clipForPath(path: string | null): ProjectClip | null {
    if (!path) return null;
    return this.clips.find((c) => c.path === path || c.url === path) ?? null;
  }

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
   *
   * Raw preview (`player.previewRaw`) turns the skip off: cut material plays
   * exactly as recorded, so the user can watch what an edit *removed*.
   */
  skipCuts = (sec: number): number => {
    if (player.previewRaw) return sec;
    for (const [a, b] of this.cutRanges) {
      if (sec >= a && sec < b) return b;
    }
    return sec;
  };

  /**
   * Move the playhead by `delta` seconds without ever landing inside a cut.
   *
   * Forward jumps to the **end** of the cut it lands in, backward to its
   * **start** — so a "back" press can never fling the playhead forward (which
   * is what the plain `skipCuts` correction did when the target fell inside a
   * cut range).
   */
  skipBy(fromSec: number, delta: number): number {
    const end = this.durationSec || Infinity;
    let t = Math.min(Math.max(fromSec + delta, 0), end);
    if (player.previewRaw) return Math.max(t, 0);
    for (const [a, b] of this.cutRanges) {
      if (t >= a && t < b) {
        t = delta >= 0 ? b : a;
        break;
      }
    }
    return Math.min(Math.max(t, 0), end);
  }

  /** Open a library entry as the current project (a new project, in effect). */
  async openLibraryEntry(id: string) {
    const e = media.get(id);
    if (!e) return;
    if (e.path) {
      // `carryDraft`: when this entry is the first clip of a brand-new project,
      // the project simply gains its source — the rest of the draft's library
      // was imported for the same project and must stay.
      await this.loadFromBackend(e.path, { carryDraft: true });
    } else if (e.asset.url) {
      // a browser blob â€” no engine, just the streamed file
      this.media = e.asset;
      this.name = e.asset.name.replace(/\.[^.]+$/, '');
    } else {
      return;
    }
    media.focusSource(id);
  }

  /**
   * Import one or more files from disk.
   *
   * Clipchamp's rule, and the fix for "video apne aap timeline par aa gayi":
   * importing fills **My media** and does nothing else. It never replaces the
   * project you are working on, never picks the source by itself and never
   * puts a clip on the timeline — that only happens when the user drags one
   * in (or presses its + button).
   */
  async importPaths(paths: string[]): Promise<string[]> {
    if (!paths.length) return [];
    // With no project open the import still needs a library of its own (a
    // draft), or the files would land in whichever project was open last.
    if (!this.media && !media.isDraft) media.startDraft();
    const fresh: Array<{ path: string; id: string }> = [];
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() ?? p;
      const entry = media.byPath(p) ?? media.addPath(p, name, 0, assetUrl(p));
      fresh.push({ path: p, id: entry.asset.id });
    }

    // Probe every new file, so each tile has a real duration, size and a
    // streamable URL. Before this loop only the **opened** file was probed,
    // which is why an import that did not become the project sat at "…"
    // with a blank poster forever.
    for (const { path, id } of fresh) {
      const entry = media.get(id);
      if (!entry || (entry.phase === 'ready' && entry.asset.url)) continue;
      const kind = clipKind(entry.asset.name);
      if (kind === 'image') {
        // A still has no duration in the file; five seconds is the clip the
        // timeline gets, and nothing is decoded until it is shown.
        media.probed(id, { url: assetUrl(path), durationSecs: 5, durationLabel: '0:05' });
        continue;
      }
      if (!isTauri()) continue;
      try {
        const info = await probeMedia(path);
        const secs = Math.max(0, Math.floor(info.durationSecs));
        media.probed(id, {
          url: assetUrl(path),
          durationSecs: info.durationSecs,
          width: info.width ?? 0,
          height: info.height ?? 0,
          fps: info.fps ?? 0,
          sizeBytes: info.sizeBytes,
          videoCodec: info.videoCodec ?? 'unknown',
          audioCodec: info.audioCodec,
          durationLabel: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
        });
      } catch (e) {
        media.failed(id);
        logAppEvent('error', 'import', `${path}: ${String(e)}`);
      }
    }

    // Nothing else. The files are in My media; the timeline stays exactly as
    // the user left it until they drag one in — a caller that *did* mean
    // "put it on the timeline" (a drop on the lane) uses the returned ids.
    this.ready = true;
    return fresh.map((f) => f.id);
  }

  /**
   * Add dropped files to the library. Split out from `importBlobs` because a
   * drop that lands on the timeline needs **every** id to place, while the
   * "this file is the project" caller only wants the first one.
   */
  private addBlobEntries(files: File[]): string[] {
    if (!this.media && !media.isDraft) media.startDraft();
    const ids: string[] = [];
    for (const f of files) {
      const isImage = f.type.startsWith('image/');
      if (!f.type.startsWith('video/') && !f.type.startsWith('audio/') && !isImage) continue;
      const url = URL.createObjectURL(f);
      const entry = media.add(f, url);
      media.probed(entry.asset.id, {
        url,
        durationSecs: isImage ? 5 : 0,
        durationLabel: isImage ? '0:05' : '…'
      });
      ids.push(entry.asset.id);
    }
    return ids;
  }

  /** User-dropped files in the browser (no filesystem path). */
  async importBlobs(files: File[]): Promise<string | null> {
    return this.addBlobEntries(files)[0] ?? null;
  }

  /**
   * User-dropped files in the **browser** (no filesystem path behind them).
   *
   * The desktop never comes here: Tauri's own drag-drop event hands over the
   * real path, which is what `importPaths` needs. A blob cannot be probed by
   * FFmpeg or stored in SQLite, so importing one on the desktop would only
   * ever produce a fake asset.
   */
  async importDropped(files: File[]): Promise<string[]> {
    return this.addBlobEntries(files);
  }

  /** User-dropped files must not navigate the window away. */
  private snapshot(): Snapshot {
    // Plain object copies — `structuredClone` cannot clone Svelte's reactive
    // proxies, and every field we keep here is a primitive or an array.
    return {
      lines: this.lines.map((l) => ({ ...l })),
      segmentOrder: [...this.segmentOrder],
      splitMarks: [...this.splitMarks],
      cutSpans: this.cutSpans.map(([a, b]) => [a, b] as [number, number]),
      mutedSegments: [...this.mutedSegments],
      segmentVolume: { ...this.segmentVolume },
      hiddenTracks: [...this.hiddenTracks]
    };
  }

  private apply(snap: Snapshot) {
    this.lines = snap.lines.map((l) => ({ ...l }));
    this.segmentOrder = [...snap.segmentOrder];
    this.splitMarks = [...snap.splitMarks];
    this.cutSpans = (snap.cutSpans ?? []).map(([a, b]) => [a, b] as [number, number]);
    this.mutedSegments = [...snap.mutedSegments];
    this.segmentVolume = { ...snap.segmentVolume };
    this.hiddenTracks = [...snap.hiddenTracks];
    this.cursor = Math.max(0, Math.min(this.lines.length - 1, this.cursor));
    this.selectedIds = [];
    this.scheduleAutosave();
  }

  private commit() {
    this.past.push(this.snapshot());
    // The stack cap scales with the transcript. A snapshot literally holds
    // every line object ({ ...l }), so a 4 000-line interview leaves a
    // 30-step stack holding ~120 000 objects. Long cut → fewer steps; the
    // classic 30 stays for everyday transcripts.
    const cap = this.lines.length > 2000 ? 6 : this.lines.length > 400 ? 12 : 30;
    if (this.past.length > cap) this.past.shift();
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
    this.selectedIds = this.isSelected(id)
      ? this.selectedIds.filter((x) => x !== id)
      : [...this.selectedIds, id];
  }

  /** Replace or extend the transcript/clip selection in one go. */
  selectMany(ids: string[], additive = false) {
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
    const set = new Set(this.selectedIds);
    const allSelected = ids.every((id) => set.has(id));
    for (const id of ids) {
      if (allSelected) set.delete(id);
      else set.add(id);
    }
    this.selectedIds = [...set];
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

  /** A clip's loudness, clamped to 0..1. Defaults to 1. */
  segmentGain = (id: string): number => {
    const v = this.segmentVolume[id];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  };

  /** Set a clip's loudness. 1 = unchanged; the number only lives in state. */
  setSegmentVolume(id: string, gain: number) {
    const next = Math.min(1, Math.max(0, gain));
    if (Math.abs(this.segmentGain(id) - next) < 0.005) return;
    this.commit();
    const map = { ...this.segmentVolume };
    if (Math.abs(next - 1) < 0.005) delete map[id];
    else map[id] = next;
    this.segmentVolume = map;
  }

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
   * One button, one eye: hide (or show) the audio and video tracks together.
   * The old separate `V` (video) / `A` (audio) buttons become one toggle.
   */
  toggleTracksHidden() {
    this.commit();
    const hiding = !(this.isTrackHidden('audio') && this.isTrackHidden('video'));
    this.hiddenTracks = hiding ? ['audio', 'video'] : [];
  }

  /** Show both tracks again — the inverse of `toggleTracksHidden`. */
  showTracks() {
    this.commit();
    this.hiddenTracks = [];
  }

  /** Hide both tracks — the inverse of `showTracks`. */
  hideTracks() {
    this.commit();
    this.hiddenTracks = ['audio', 'video'];
  }

  /**
   * Show exactly one track and hide the other: "only video" (the picture, with
   * the sound off) or "only audio" (the sound, with the stage dark).
   *
   * This is not the same as `toggleTrackHidden`: from "both hidden" that
   * toggle would *show* the track it is given and leave the other one hidden,
   * while "only X" always means the other track is off. The two never disagree
   * about what the eye shows, because both write `hiddenTracks` in one go.
   */
  onlyTrack(track: TrackId) {
    this.commit();
    this.hiddenTracks = track === 'video' ? ['audio'] : ['video'];
  }

  /**
   * Cut whole clips **without deleting them**.
   *
   * The block stays on the timeline as red material (the diagram's rule:
   * nothing ever hides). With a transcript the rows flip to `cut`; with none,
   * the source range joins `cutSpans`, which is the only truth a
   * transcript-less project has. Either way `restoreSegments()` reverses it.
   */
  cutSegments(ids: string[]): number {
    const wanted = new Set(ids);
    const targets = this.segments.filter((s) => wanted.has(s.id));
    if (!targets.length) return 0;
    this.commit();
    const lineIds = new Set(targets.flatMap((s) => s.lines.map((l) => l.id)));
    if (lineIds.size) {
      this.lines = this.lines.map((l) =>
        lineIds.has(l.id) ? { ...l, keep: 'cut' as KeepState } : l
      );
    }
    // A segment with no transcript rows (transcript-less project) is cut by
    // time instead — this is also what keeps a cut red when a later
    // transcript fails to cover the stretch.
    const spans = [...this.cutSpans];
    let grew = false;
    for (const s of targets) {
      if (s.lines.length) continue;
      spans.push([s.startSec, s.endSec]);
      grew = true;
    }
    if (grew) this.cutSpans = weldSpans(spans);
    this.selectedIds = [];
    // The block stays in the order: it is still on the timeline, just red.
    // Mute/volume also stay, so Restore brings the clip back exactly as it was.
    return targets.length;
  }

  /**
   * Put cut clips back on the timeline — the counterpart of `cutSegments`.
   *
   * Rows flip back to `keep`, time cuts are carved out of `cutSpans`, and the
   * segments glue back into their neighbours on the next derivation. Nothing
   * on this timeline is ever permanently deleted.
   */
  restoreSegments(ids: string[]): number {
    const wanted = new Set(ids);
    const targets = this.segments.filter((s) => wanted.has(s.id) && s.state === 'cut');
    if (!targets.length) return 0;
    this.commit();
    const lineIds = new Set(targets.flatMap((s) => s.lines.map((l) => l.id)));
    if (lineIds.size) {
      this.lines = this.lines.map((l) =>
        lineIds.has(l.id) ? { ...l, keep: 'keep' as KeepState } : l
      );
    }
    let spans: Array<[number, number]> = this.cutSpans.map(([a, b]) => [a, b]);
    for (const s of targets) {
      if (s.lines.length) continue;
      spans = subtractSpan(spans, s.startSec, s.endSec);
    }
    this.cutSpans = weldSpans(spans);
    return targets.length;
  }

  /**
   * A time cut must show in the transcript too: rows whose midpoint lies
   * inside a `cutSpans` range are marked `cut`, so the panel and the red
   * block never disagree. Called when a transcript arrives (load or
   * regeneration) — the spans are older truth than the rows.
   */
  private syncCutsIntoLines() {
    if (!this.cutSpans.length || !this.lines.length) return;
    const inside = (l: TranscriptLine) => {
      const at = (l.startSec + l.endSec) / 2;
      return this.cutSpans.some(([a, b]) => at >= a && at < b);
    };
    if (!this.lines.some((l) => l.keep === 'keep' && inside(l))) return;
    this.lines = this.lines.map((l) =>
      l.keep === 'keep' && inside(l) ? { ...l, keep: 'cut' as KeepState } : l
    );
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
    if (this.segmentVolume[oldId] !== undefined) {
      const next = { ...this.segmentVolume };
      next[newId] = next[oldId];
      delete next[oldId];
      this.segmentVolume = next;
    }
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
      // The playhead is over a *block*, not a transcript row — a red cut, a
      // grey silence, or the gap between two kept rows. The timeline is the
      // master, so the split cuts the block in two instead of silently
      // splitting whichever row the cursor happened to be on. 0.35 s keeps
      // the halves usable (a 0.1 s sliver is not a clip).
      const seg = this.orderedSegments.find(
        (s) => sec > s.startSec + 0.35 && sec < s.endSec - 0.35
      );
      if (seg) {
        this.commit();
        this.splitMarks = [...this.splitMarks, sec].sort((a, b) => a - b);
        return true;
      }
      if (!this.lines[this.cursor]) {
        // No transcript row to split: the timeline is still the master, so
        // the mark becomes a hard clip boundary and the split lands as two
        // blocks instead of doing nothing.
        const dur = this.durationSec;
        if (dur <= 0.5 || sec <= 0.25 || sec >= dur - 0.25) return false;
        this.commit();
        this.splitMarks = [...this.splitMarks, sec].sort((a, b) => a - b);
        return true;
      }
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
   * Split an **extra clip** in two at a local time.
   *
   * Clipchamp's split makes a new clip out of the right half; T9 keeps the
   * same rule for the clips that come after the main cut. Nothing is decoded:
   * the two halves are the same file with different `in/out` points, so the
   * export still cuts from the original bytes.
   */
  splitClipAt(clipId: string, localSec: number): boolean {
    const i = this.clips.findIndex((c) => c.id === clipId);
    if (i < 0) return false;
    const c = this.clips[i];
    const at = Math.max(c.inSec + 0.2, Math.min(c.outSec - 0.2, localSec));
    if (at - c.inSec < 0.2 || c.outSec - at < 0.2) return false;
    const left: ProjectClip = { ...c, id: crypto.randomUUID(), outSec: at };
    const right: ProjectClip = { ...c, id: crypto.randomUUID(), inSec: at };
    this.clips = [...this.clips.slice(0, i), left, right, ...this.clips.slice(i + 1)];
    // Stay on the left half so the preview has a real src and the playhead
    // stays on the frame that was split.
    this.activeClipId = left.id;
    this.saveClips();
    return true;
  }

  /**
   * Split whatever the playhead is over, in one call.
   *
   * The keyboard shortcut and the toolbar button both come here, so an extra
   * clip splits into two clips and the main cut splits into two blocks (red
   * and grey included) instead of each surface re-deciding.
   */
  splitAtPlayhead(): 'clip' | 'timeline' | null {
    // An extra clip is a different video: falling through to `splitAt` would
    // cut the main source at the clip's local time.
    if (this.activeClip) {
      return this.splitClipAt(this.activeClip.id, player.currentTime) ? 'clip' : null;
    }
    return this.splitAt(player.currentTime) ? 'timeline' : null;
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
