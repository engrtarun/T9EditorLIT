/**
 * The export defaults a project can be created with.
 *
 * "Create New Project" asks where the finished file should go and how big it
 * should be. Those are **machine-level defaults** — the next project on this
 * PC should start with the same answer — so they live in `localStorage`, next
 * to the other per-machine choices, and not in the project's SQLite row.
 *
 * A default is never a cage: the Export panel's save dialog still opens, so
 * any single export can choose a different folder or size.
 */

import { RESOLUTIONS, type ResolutionId } from '../export-presets';

const DIR_KEY = 't9-editor-lit.exportDir';
const RES_KEY = 't9-editor-lit.exportResolution';

function coerceResolution(raw: unknown): ResolutionId {
  return RESOLUTIONS.some((r) => r.id === raw) ? (raw as ResolutionId) : 'source';
}

class ExportDefaultsStore {
  /** Folder the save dialog starts in. Empty = wherever Windows last opened it. */
  dir = $state('');

  /** Resolution the Export panel opens with. `source` keeps the recording's size. */
  resolution = $state<ResolutionId>('source');

  /**
   * `C:\Exports\my video (cut).mp4`, or just the file name when no folder was
   * chosen — which is exactly what the app did before this setting existed.
   */
  pathFor(name: string): string {
    const dir = this.dir.trim();
    if (!dir) return name;
    return `${dir.replace(/[\\/]+$/, '')}\\${name}`;
  }

  setDir(dir: string): void {
    this.dir = dir.trim();
    this.persist();
  }

  setResolution(res: ResolutionId): void {
    this.resolution = coerceResolution(res);
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(DIR_KEY, this.dir);
      localStorage.setItem(RES_KEY, this.resolution);
    } catch {
      /* private mode — the defaults just do not stick */
    }
  }

  constructor() {
    try {
      this.dir = localStorage.getItem(DIR_KEY) ?? '';
      this.resolution = coerceResolution(localStorage.getItem(RES_KEY));
    } catch {
      /* private mode */
    }
  }
}

export const exportDefaults = new ExportDefaultsStore();
