/**
 * Top-bar RAM meter state.
 *
 * Polling (not pushing) is deliberate: the WebView asks Rust for a number every
 * 1.5s and gets one. A push channel would mean Rust holding a subscription list
 * and the frontend holding an event handler — more resident memory to achieve
 * the same result.
 *
 * Polling also stops while the document is hidden (window minimised or fully
 * covered): the meter is not on screen, so the timer is pure wake-up cost — a
 * Rust process enumeration, a JSON serialisation and a Svelte state write that
 * nobody can see. `visibilitychange` re-arms it and takes one fresh reading
 * immediately, so returning to the window never shows a stale figure.
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
    document.addEventListener("visibilitychange", this.#onVisibility);
    this.#arm();
    void this.refresh();
  }

  stop(): void {
    document.removeEventListener("visibilitychange", this.#onVisibility);
    this.#disarm();
  }

  #onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      this.#disarm();
      return;
    }
    this.#arm();
    void this.refresh();
  };

  #arm(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  #disarm(): void {
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
