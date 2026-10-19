import type {
  KeepState,
  MediaAsset,
  TextClip,
  TimelineClip,
  TranscriptLine,
  WaveformData
} from '../types';
import { MOCK_DURATION_SEC, MOCK_LINES, mockWaveform } from '../mock';

const CLIP_HISTORY_LIMIT = 120;

type Snapshot = Record<string, KeepState>;

/** Splitting produces `ln-012-a` / `ln-012-b`; undo must still find the parent. */
function baseId(id: string): string {
  return id.replace(/-[ab]$/, '');
}

class ProjectStore {
  name = $state('apna-college-vite-intro');
  media = $state<MediaAsset | null>(null);
  lines = $state<TranscriptLine[]>(structuredClone(MOCK_LINES));
  clips = $state<TimelineClip[]>([]);
  texts = $state<TextClip[]>([
    { id: 't1', startSec: 10, endSec: 20, text: 'Vite kya hai?', kind: 'title' },
    { id: 't2', startSec: 96, endSec: 112, text: 'Config & Plugins', kind: 'heading' },
    { id: 't3', startSec: 126, endSec: 142, text: 'npm install vite', kind: 'code-zoom' }
  ]);
  waveform = $state<WaveformData>(mockWaveform(MOCK_DURATION_SEC));

  /** Index of the transcript line the keyboard cursor sits on. */
  cursor = $state(0);

  /** Magnet: playhead snaps to line boundaries when true. */
  snap = $state(true);

  /** Right-rail CC toggle — hides/shows the transcript panel. */
  showTranscript = $state(true);

  past = $state<Snapshot[]>([]);
  future = $state<Snapshot[]>([]);

  durationSec = $derived(this.media?.durationSec ?? MOCK_DURATION_SEC);

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
    if (this.past.length > CLIP_HISTORY_LIMIT) this.past.shift();
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

  /**
   * Split the transcript line under the playhead into two (Clipchamp's ✂).
   * The right half inherits the parent's verdict, the left half keeps the text.
   */
  splitAt(sec: number): boolean {
    const idx = this.lineAt(sec);
    if (idx < 0) return false;
    const line = this.lines[idx];
    // too close to an edge to split meaningfully
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

  loadFile(file: File, url: string) {
    this.name = file.name.replace(/\.[^.]+$/, '');
    this.media = {
      id: crypto.randomUUID(),
      name: file.name,
      url,
      durationSec: 0,
      width: 0,
      height: 0,
      fps: 0,
      sizeBytes: file.size
    };
    this.lines = [];
    this.clips = [];
    this.cursor = 0;
  }
}

export const project = new ProjectStore();
