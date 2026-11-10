/**
 * The ad blocker's view model — uBlock Origin Lite (MV3), shipped on.
 *
 * There are two independent truths and the panel shows both, because they
 * answer different questions:
 *
 *  - **disk** (`GET /v1/ublock/status` from the Go daemon): which release is
 *    unpacked, whether the next check failed, and when the last one ran. The
 *    daemon downloads the official GitHub release, verifies the SHA-256 that
 *    GitHub publishes, and re-checks every few hours — so a new release needs
 *    no user action. Lite (MV3) is deliberate: classic uBO is MV2 and current
 *    Chromium refuses to run it at all.
 *  - **runtime** (`browser:extensions` from Rust/WebView2): whether the tab
 *    profile *actually loaded* it. `extensions_path` is fire-and-forget — wry
 *    ignores `AddBrowserExtension` failures — so a folder on disk is not proof
 *    of a running blocker, and the UI never claims it is.
 *
 * Everything is read-only here: the daemon owns installation, the webview owns
 * the load. This store just mirrors both and asks for a check when the user
 * presses the button.
 */

import type { BrowserExtensionsEvent, UBlockStatus } from '../types';
import { isTauri, onBrowserExtensions } from '../ipc';

const DAEMON = 'http://127.0.0.1:7878';
/** While an update is being fetched, ask the daemon how it is going. */
const UPDATE_POLL_MS = 1200;
/** Bound the polling: a stuck GitHub call must not poll forever. */
const UPDATE_MAX_POLLS = 75;

class UBlockStore {
  /** Disk truth from the daemon; `null` = never answered yet. */
  status = $state<UBlockStatus | null>(null);
  /** Daemon reachable? The panel says so instead of showing stale numbers. */
  reachable = $state(true);

  /**
   * What WebView2 reported for the most recent visible tab. `unknown` until a
   * tab has been shown (there is no profile to ask before then).
   */
  runtime = $state<'unknown' | 'loaded' | 'missing'>('unknown');
  /** Names WebView2 listed, verbatim — shown when uBlock is missing. */
  runtimeNames = $state<string[]>([]);
  runtimeError = $state<string | null>(null);

  private unlisten: (() => void) | undefined;
  private pollTimers: ReturnType<typeof setTimeout>[] = [];

  /** The name WebView2 gave the loaded blocker, if it reported one. */
  get runtimeName(): string | null {
    const hit = this.runtimeNames.find((n) => /ublock/i.test(n));
    return hit ?? null;
  }

  /** "1.76.0" when installed, empty otherwise. */
  get version(): string {
    return this.status?.installed ? this.status.version : '';
  }

  /**
   * Wire the runtime listener and read the disk status once. Called when the
   * browser view mounts; repeated calls are harmless (listener is kept).
   */
  boot(): void {
    if (!isTauri()) return;
    if (!this.unlisten) {
      void onBrowserExtensions((p) => this.noteRuntime(p))
        .then((off) => {
          this.unlisten = off;
        })
        .catch(() => {
          /* event plugin unavailable in a stripped build; disk truth stands */
        });
    }
    void this.refresh();
  }

  /** One `/v1/ublock/status` read (no GitHub call — the daemon does that). */
  async refresh(): Promise<void> {
    if (!isTauri()) return;
    try {
      const res = await fetch(`${DAEMON}/v1/ublock/status`, { cache: 'no-store' });
      if (!res.ok) {
        this.reachable = false;
        return;
      }
      this.status = (await res.json()) as UBlockStatus;
      this.reachable = true;
    } catch {
      this.reachable = false;
    }
  }

  /**
   * Ask for a check now and poll until the daemon says it is done. The GitHub
   * call itself is in the daemon's background, which is why the POST answers
   * `updating: true` instead of blocking.
   */
  async updateNow(): Promise<void> {
    if (!isTauri()) return;
    try {
      const res = await fetch(`${DAEMON}/v1/ublock/update`, { method: 'POST' });
      if (!res.ok) {
        this.reachable = false;
        return;
      }
      this.status = (await res.json()) as UBlockStatus;
      this.reachable = true;
    } catch {
      this.reachable = false;
      return;
    }

    for (let i = 0; i < UPDATE_MAX_POLLS; i++) {
      if (!this.status?.updating) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, UPDATE_POLL_MS);
        this.pollTimers.push(t);
      });
      await this.refresh();
    }
  }

  /** Rust's `browser:extensions` payload for the tab that just became visible. */
  noteRuntime(p: BrowserExtensionsEvent): void {
    this.runtimeNames = Array.isArray(p.names) ? p.names : [];
    this.runtimeError = p.error;
    const on = this.runtimeNames.some((n, i) => /ublock/i.test(n) && (p.enabled?.[i] ?? false));
    this.runtime = on ? 'loaded' : 'missing';
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = undefined;
    for (const t of this.pollTimers) clearTimeout(t);
    this.pollTimers = [];
  }
}

export const ublock = new UBlockStore();
