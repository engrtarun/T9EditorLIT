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

import type {
  BrowserExtensionsEvent,
  BrowserUblockReply,
  UBlockStatus,
  UBlockPanelData
} from '../types';
import { isTauri, onBrowserExtensions, browserUblockCall, onBrowserUblock } from '../ipc';

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
   * Per-site filtering-mode panel (real uBOL controls). `panelOpen` is the
   * layout-sheet flag BrowserView parks the page on, exactly like settings.
   */
  panelOpen = $state(false);
  site = $state('');
  panel = $state<UBlockPanelData | null>(null);
  level = $state(-1);
  busy = $state(false);
  error = $state<string | null>(null);

  private pending = new Map<string, (ok: boolean, response: unknown) => void>();
  private unlistenReply: (() => void) | undefined;

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
    if (!this.unlistenReply) {
      void onBrowserUblock((p) => this.noteReply(p))
        .then((off) => {
          this.unlistenReply = off;
        })
        .catch(() => {
          /* bridge reply channel unavailable; controls degrade honestly */
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

  /** One reply from the uBOL control bridge, matched by id. */
  noteReply(p: BrowserUblockReply): void {
    const cb = this.pending.get(p.id);
    if (cb) cb(p.ok, p.response);
  }

  private async call(
    what: string,
    args: Record<string, unknown>,
    timeoutMs = 5000
  ): Promise<unknown> {
    const id = await browserUblockCall(what, args);
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('uBlock bridge ne jawab nahi diya (timeout)'));
      }, timeoutMs);
      this.pending.set(id, (ok, response) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (ok) resolve(response);
        else reject(new Error(String(response ?? 'uBOL error')));
      });
    });
  }

  /** Open the real per-site control panel for the given hostname. */
  async openPanel(hostname: string): Promise<void> {
    this.site = hostname || '';
    this.panel = null;
    this.level = -1;
    this.error = null;
    this.panelOpen = true;
    if (!hostname) {
      this.error = 'Is page par uBlock controls nahi chal sakte';
      return;
    }
    try {
      const data = (await this.call('popupPanelData', { hostname })) as UBlockPanelData;
      this.panel = data;
      this.level = typeof data?.level === 'number' ? data.level : -1;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Close the panel without touching uBOL state. */
  closePanel(): void {
    this.panelOpen = false;
  }

  /** Flip the per-site filtering mode (0 no filtering .. 3 complete). */
  async setLevel(level: number): Promise<void> {
    if (!this.site || this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      const actual = await this.call('setFilteringMode', { hostname: this.site, level });
      this.level = typeof actual === 'number' ? actual : level;
      if (this.panel) this.panel.level = this.level;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Inject one of uBOL's page tools (zapper / element picker / unpicker).
   * The worker patch (PatchBackground) is what makes this work, because a
   * content script has no chrome.scripting of its own.
   */
  async runTool(kind: 'zapper' | 'picker' | 'unpicker'): Promise<void> {
    const files: Record<string, string[]> = {
      zapper: ['/js/scripting/tool-overlay.js', '/js/scripting/zapper.js'],
      picker: [
        '/js/scripting/css-procedural-api.js',
        '/js/scripting/tool-overlay.js',
        '/js/scripting/picker.js'
      ],
      unpicker: [
        '/js/scripting/css-procedural-api.js',
        '/js/scripting/tool-overlay.js',
        '/js/scripting/unpicker.js'
      ]
    };
    this.busy = true;
    this.error = null;
    try {
      await this.call('t9RunFiles', { files: files[kind] });
      this.panelOpen = false;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = undefined;
    this.unlistenReply?.();
    this.unlistenReply = undefined;
    for (const t of this.pollTimers) clearTimeout(t);
    this.pollTimers = [];
  }
}

export const ublock = new UBlockStore();
