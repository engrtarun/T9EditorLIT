/**
 * Top-bar RAM meter state.
 *
 * Polling (not pushing) is deliberate: the WebView asks Rust for a number every
 * 1.5s and gets one. A push channel would mean Rust holding a subscription list
 * and the frontend holding an event handler — more resident memory to achieve
 * the same result.
 */

import { errorMessage, getMemoryStats } from "../ipc";
import type { MemoryStats } from "../types";

const POLL_INTERVAL_MS = 1500;

class MemoryStore {
  stats = $state<MemoryStats | null>(null);
  error = $state<string | null>(null);

  #timer: ReturnType<typeof setInterval> | null = null;

  async refresh(): Promise<void> {
    try {
      this.stats = await getMemoryStats();
      this.error = null;
    } catch (err) {
      this.error = errorMessage(err);
    }
  }

  start(): void {
    if (this.#timer !== null) return;
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

export const memory = new MemoryStore();

/** `6.1 GB`, `412 MB` — matches what Windows shows in Task Manager. */
export function formatRam(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
