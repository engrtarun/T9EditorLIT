/**
 * The fast-download queue's view model.
 *
 * The bytes are never here: the Go daemon (`t9cloud`) owns the multi-segment
 * download and counts every byte on its side. This store only mirrors the
 * daemon's `/v1/dl` list (one small JSON, polled at 800 ms while anything is
 * running) so the panel can draw bars from the same numbers the downloader
 * counts.
 *
 * While the daemon is down (dev preview, or `t9cloud` not installed yet) the
 * poll fails silently and the panel shows its empty state — the browser never
 * breaks because a downloader is missing.
 */

import type { DownloadItem } from '../types';
import { isTauri } from '../ipc';

const DAEMON = 'http://127.0.0.1:7878';
const POLL_MS = 800;

class DownloadsStore {
  items = $state<DownloadItem[]>([]);
  /** The slide-up panel is open. */
  open = $state(false);
  /** Polling is armed (at least one non-terminal item, or the panel is open). */
  private timer: ReturnType<typeof setInterval> | undefined;

  get activeCount(): number {
    return this.items.filter((i) => i.status === 'running' || i.status === 'paused').length;
  }

  toggle(): void {
    this.open = !this.open;
    this.syncTimer();
  }

  /** Ask the daemon to start a multi-segment download. */
  async start(url: string, opts?: { referer?: string }): Promise<void> {
    if (!isTauri()) return;
    try {
      const res = await fetch(`${DAEMON}/v1/dl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, referer: opts?.referer ?? null })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `daemon refused the download (${res.status})`);
      }
      this.open = true;
      this.syncTimer();
      await this.poll();
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  act(id: string, action: 'pause' | 'resume' | 'cancel'): void {
    if (!isTauri()) return;
    void fetch(`${DAEMON}/v1/dl/${id}/${action}`, { method: 'POST' })
      .then(() => this.poll())
      .catch(() => {});
  }

  dismiss(id: string): void {
    // Terminal rows only leave the list when asked; the daemon keeps its own
    // record until the file is cleaned.
    this.items = this.items.filter(
      (i) => i.id !== id || i.status === 'running' || i.status === 'paused'
    );
  }

  private async poll(): Promise<void> {
    if (!isTauri()) return;
    try {
      const res = await fetch(`${DAEMON}/v1/dl`, { cache: 'no-store' });
      if (res.ok) {
        const list = (await res.json()) as DownloadItem[];
        this.items = Array.isArray(list) ? list : [];
      }
    } catch {
      /* daemon not up — the panel simply shows what it has */
    }
    this.syncTimer();
  }

  /** Poll only while something can change; stop when the queue is quiet. */
  private syncTimer(): void {
    const need = this.open || this.items.some((i) => i.status === 'running');
    if (need && !this.timer) {
      this.timer = setInterval(() => void this.poll(), POLL_MS);
    } else if (!need && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One poll at boot, so an unfinished queue from last session shows up. */
  boot(): void {
    void this.poll();
  }
}

export const downloads = new DownloadsStore();
