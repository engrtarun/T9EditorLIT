/**
 * Reactive editor state, as a Svelte 5 runes class.
 *
 * The pure edit rules live in `timeline.ts` and are unit-tested there; this
 * file only owns state, selection and undo history.
 *
 * Panel isolation (AGENTS.md): the UI mounts one mode at a time. Callers key
 * their components off `editor.mode` so switching destroys the previous tree.
 */

import {
  clipEnd,
  findCollision,
  moveClip,
  rippleDelete,
  snap,
  splitClip,
  timelineDuration,
  trimLeft,
  trimRight,
} from "./timeline.ts";
import {
  defaultExportSettings,
  neutralLook,
  type Asset,
  type CaptionCue,
  type Clip,
  type ExportSettings,
  type LookAdjustments,
  type TextLayer,
  type Track,
} from "./types.ts";

export type EditorMode = "edit" | "captions" | "export";

interface HistoryEntry {
  tracks: Track[];
  clips: Clip[];
}

let idCounter = 0;
/** Monotonic id. Stable across save/load so selection survives a reload. */
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}_${Date.now().toString(36)}`;
}

export class Editor {
  mode: EditorMode = $state("edit");
  playing: boolean = $state(false);

  assets: Asset[] = $state([]);
  tracks: Track[] = $state([]);
  clips: Clip[] = $state([]);
  textLayers: TextLayer[] = $state([]);
  captions: CaptionCue[] = $state([]);

  selectedClipId: string | null = $state(null);
  selectedAssetId: string | null = $state(null);
  playheadSecs: number = $state(0);
  zoomPxPerSec: number = $state(60);

  look: LookAdjustments = $state(neutralLook());
  exportSettings: ExportSettings = $state(defaultExportSettings());

  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #txn: HistoryEntry | null = null;

  // ---- derived --------------------------------------------------------

  durationSecs: number = $derived(
    timelineDuration(this.tracks.map((t) => ({ clips: this.clipsOn(t.id) }))),
  );

  selectedClip: Clip | null = $derived(
    this.clips.find((c) => c.id === this.selectedClipId) ?? null,
  );

  clipsOn(trackId: string): Clip[] {
    return this.clips
      .filter((c) => c.trackId === trackId)
      .sort((a, b) => a.startSecs - b.startSecs);
  }

  trackById(trackId: string): Track | undefined {
    return this.tracks.find((t) => t.id === trackId);
  }

  assetById(assetId: string): Asset | undefined {
    return this.assets.find((a) => a.id === assetId);
  }

  // ---- history --------------------------------------------------------

  /**
   * Begin a transaction. Nested calls collapse into the outermost one so a
   * compound drag produces a single undo step.
   */
  begin(): void {
    this.#txn ??= { tracks: this.#snapshotTracks(), clips: structuredClone(this.clips) };
  }

  /** Commit the open transaction, or do nothing when nothing changed. */
  commit(): void {
    const entry = this.#txn;
    this.#txn = null;
    if (!entry) return;
    this.#undo.push(entry);
    if (this.#undo.length > 100) this.#undo.shift();
    this.#redo = [];
  }

  /** Abort the open transaction and roll state back to where `begin` was called. */
  revert(): void {
    const entry = this.#txn;
    this.#txn = null;
    if (!entry) return;
    this.tracks = structuredClone(entry.tracks);
    this.clips = structuredClone(entry.clips);
  }

  canUndo: boolean = $derived(this.#undo.length > 0);
  canRedo: boolean = $derived(this.#redo.length > 0);

  undo(): void {
    const entry = this.#undo.pop();
    if (!entry) return;
    this.#redo.push({ tracks: this.#snapshotTracks(), clips: structuredClone(this.clips) });
    this.tracks = structuredClone(entry.tracks);
    this.clips = structuredClone(entry.clips);
    if (this.selectedClipId && !this.clips.some((c) => c.id === this.selectedClipId)) {
      this.selectedClipId = null;
    }
  }

  redo(): void {
    const entry = this.#redo.pop();
    if (!entry) return;
    this.#undo.push({ tracks: this.#snapshotTracks(), clips: structuredClone(this.clips) });
    this.tracks = structuredClone(entry.tracks);
    this.clips = structuredClone(entry.clips);
  }

  // ---- tracks & clips -------------------------------------------------

  addTrack(kind: Track["kind"], name?: string): Track {
    const defaultName = `${kind[0]!.toUpperCase()}${kind.slice(1)} ${this.tracks.length + 1}`;
    const track: Track = {
      id: nextId("trk"),
      kind,
      name: name ?? defaultName,
      heightPx: kind === "audio" ? 56 : 64,
      locked: false,
      muted: false,
    };
    this.tracks = [...this.tracks, track];
    return track;
  }

  removeTrack(trackId: string): void {
    this.begin();
    this.tracks = this.tracks.filter((t) => t.id !== trackId);
    this.clips = this.clips.filter((c) => c.trackId !== trackId);
    this.commit();
  }

  /**
   * Append an asset to the end of a track.
   *
   * Rejects the drop when it would overlap an existing clip on a linear track;
   * overlay tracks stack freely.
   */
  addClip(assetId: string, trackId: string, atSecs?: number): Clip | null {
    const asset = this.assetById(assetId);
    const track = this.trackById(trackId);
    if (!asset || !track || track.locked) return null;

    this.begin();
    const tail = this.clipsOn(trackId);
    const start = atSecs ?? (tail.length ? Math.max(...tail.map(clipEnd)) : 0);
    const duration = asset.kind === "image" ? 5 : asset.durationSecs;

    const clip: Clip = {
      id: nextId("clip"),
      assetId,
      trackId,
      startSecs: start,
      durationSecs: duration,
      inPointSecs: 0,
      outPointSecs: duration,
      speed: 1,
      volume: 1,
      muted: false,
      transition: null,
    };

    const blocker = findCollision(clip, this.clipsOn(trackId), track.kind);
    if (blocker) {
      this.revert();
      return null;
    }

    this.clips = [...this.clips, clip];
    this.selectedClipId = clip.id;
    this.commit();
    return clip;
  }

  /** Split the selected clip where the playhead currently sits. */
  splitSelected(): boolean {
    const clip = this.selectedClip;
    if (!clip) return false;
    const offset = this.playheadSecs - clip.startSecs;
    const parts = splitClip(clip, offset);
    if (!parts) return false;

    this.begin();
    const [head, tail] = parts;
    this.clips = [...this.clips.filter((c) => c.id !== clip.id), head, tail];
    this.selectedClipId = tail.id;
    this.commit();
    return true;
  }

  moveSelected(newStartSecs: number, snapTo = 0): void {
    const clip = this.selectedClip;
    if (!clip) return;
    const target = snapTo > 0 ? snap(newStartSecs, snapTo, 8 / this.zoomPxPerSec) : newStartSecs;
    this.updateClip(clip.id, moveClip(clip, target));
  }

  trimSelectedEnd(newDurationSecs: number): void {
    const clip = this.selectedClip;
    if (!clip) return;
    const asset = this.assetById(clip.assetId);
    this.updateClip(clip.id, trimRight(clip, newDurationSecs, asset?.durationSecs ?? 0));
  }

  trimSelectedStart(newStartSecs: number): void {
    const clip = this.selectedClip;
    if (!clip) return;
    this.updateClip(clip.id, trimLeft(clip, newStartSecs));
  }

  updateClip(clipId: string, patch: Clip): void {
    this.clips = this.clips.map((c) => (c.id === clipId ? patch : c));
  }

  /** Patch selected-clip fields inside one undo step. */
  patchSelected(patch: Partial<Clip>): void {
    const clip = this.selectedClip;
    if (!clip) return;
    this.begin();
    this.updateClip(clip.id, { ...clip, ...patch });
    this.commit();
  }

  /** Remove the selected clip, optionally closing the gap it leaves behind. */
  deleteSelected(ripple = false): void {
    const clip = this.selectedClip;
    if (!clip) return;
    this.begin();

    if (ripple) {
      // Rewrite only the affected track; other tracks keep their timing.
      const siblings = this.clipsOn(clip.trackId);
      const closed = rippleDelete(siblings, clip.id, clipEnd(clip), clip.startSecs);
      const otherTracks = this.clips.filter((c) => c.trackId !== clip.trackId);
      this.clips = [...otherTracks, ...closed];
    } else {
      this.clips = this.clips.filter((c) => c.id !== clip.id);
    }

    this.selectedClipId = null;
    this.commit();
  }

  // ---- transport ------------------------------------------------------

  seek(secs: number): void {
    this.playheadSecs = Math.min(Math.max(0, secs), Math.max(this.durationSecs, 0));
  }

  togglePlay(): void {
    this.playing = !this.playing;
  }

  #snapshotTracks(): Track[] {
    return structuredClone(this.tracks);
  }
}

/** Single app-wide editor instance. */
export const editor = new Editor();
