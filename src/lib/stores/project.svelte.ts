/**
 * The currently loaded source video and its ffprobe facts.
 *
 * Held app-wide because both the preview and the export engine need the path,
 * and re-probing a 5 GB file for every consumer would be wasteful.
 */

import { errorMessage, probeMedia, defaultDbPath, saveProject } from "../ipc";
import type { MediaInfo } from "../types";

class ProjectStore {
  info = $state<MediaInfo | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  get hasMedia(): boolean {
    return this.info !== null;
  }

  /** Duration label for the top bar, e.g. `02:14:37`. */
  get durationLabel(): string {
    if (!this.info) return "--:--";
    const total = Math.floor(this.info.durationSecs);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  async load(path: string): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      // dbPath resolves in parallel with probeMedia so the save doesn't wait.
      const dbPathPromise = defaultDbPath();
      this.info = await probeMedia(path);
      const dbPath = await dbPathPromise;
      // Persist to Recent Projects so it shows on the Home Screen next time.
      const name = path.split(/[\\/]/).pop() ?? path;
      const id = path;
      const now = Date.now();
      await saveProject(dbPath, id, name, path, this.info.durationSecs, now);
    } catch (err) {
      this.error = errorMessage(err);
      this.info = null;
    } finally {
      this.loading = false;
    }
  }

  clear(): void {
    this.info = null;
    this.error = null;
  }
}

export const project = new ProjectStore();

/** `4.8 GB` from a byte count. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
