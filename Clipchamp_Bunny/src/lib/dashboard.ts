/**
 * Small helpers for the home dashboard.
 *
 * Everything here is pure and cheap — the dashboard is the first thing the
 * user sees, so it must not make anybody wait.
 */
import type { RustProject } from './ipc';

/** One project, plus what the dashboard learned about it in the background. */
export interface ProjectCard {
  project: RustProject;
  /** Size of the source file on disk, in bytes (0 until it has been probed). */
  sizeBytes: number;
  /** `asset:` URL of the cached poster frame, once FFmpeg has made one. */
  posterUrl: string | null;
  /**
   * The video itself, used when no poster frame could be extracted.
   *
   * The `<video>` element streams it — the file never enters the heap — so a
   * card is never blank just because FFmpeg could not make a still.
   */
  previewUrl: string | null;
  /** True while the project is being opened. */
  opening: boolean;
}

/** How the list can be ordered. */
export type SortKey = 'recent' | 'name' | 'duration';

export const SORT_LABEL: Record<SortKey, string> = {
  recent: 'Recently opened',
  name: 'Name',
  duration: 'Length'
};

/** Order the list for the chosen key. */
export function sortProjects(cards: ProjectCard[], key: SortKey): ProjectCard[] {
  const out = [...cards];
  if (key === 'name') {
    out.sort((a, b) => a.project.name.localeCompare(b.project.name));
  } else if (key === 'duration') {
    out.sort((a, b) => b.project.durationSecs - a.project.durationSecs);
  } else {
    out.sort((a, b) => b.project.lastOpened - a.project.lastOpened);
  }
  return out;
}

/**
 * "Edited 19 hours ago" — a rough, human clock.
 *
 * Unix seconds in, English out. Anything under a minute is "just now",
 * because "edited 3 seconds ago" is noise.
 */
export function ago(unixSecs: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (diff < 60) return 'just now';
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/** `452.3 MB` / `1.20 GB` — the same units the rest of the app uses. */
export function fmtBytes(bytes: number): string {
  if (!bytes) return '—';
  const mb = bytes / 1_048_576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

/** `256 GB` — drive sizes never need decimals. */
export function fmtGb(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(0)} GB`;
}

/** `4:34` — the duration badge on a card. */
export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return `${m}:${String(rest).padStart(2, '0')}`;
}
