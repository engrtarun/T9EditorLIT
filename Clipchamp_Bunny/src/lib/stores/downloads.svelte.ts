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

import type { DownloadItem, DownloadSettings } from '../types';
import { appNotify, dlSettingsGet, dlSettingsSave, isTauri } from '../ipc';
import { fmtBytes } from '../dashboard';
import { toast } from './toast.svelte';

const DAEMON = 'http://127.0.0.1:7878';
const POLL_MS = 800;

/** The "big file" line the user asked for: end toast + OS notification. */
const BIG_DOWNLOAD = 1024 ** 3;

/**
 * What a fresh install uses until the first save. This mirrors the Rust
 * default (`dl_settings::DEFAULT_CONNECTIONS`) and the Go fallback; the daemon
 * clamps anything out of range, so a drift can never break a download.
 */
const DEFAULT_SETTINGS: DownloadSettings = {
  connections: 8,
  saveDir: '',
  autoResume: true,
  notifyDone: true
};

/** A start the daemon refused, kept where the user looks for the file. */
export interface FailedDownload {
  id: string;
  filename: string;
  error: string;
}

/**
 * One finished download, kept in this webview's disk-backed store.
 *
 * The daemon is a queue, not an archive: it drops a terminal row 15 minutes
 * after it finishes (`keepTerminalFor`), which is why old downloads kept
 * "auto-cleaning". History belongs to the user, so it is written here the
 * moment a row finishes and is never touched again until they clear it.
 */
export interface DownloadHistoryEntry {
  id: string;
  url: string;
  filename: string;
  path: string;
  bytes: number;
  status: string;
  error: string | null;
  /** Unix ms the transfer started (0 = unknown, e.g. a row from a sidecar). */
  startedAt: number;
  /** Unix ms it reached its terminal status. */
  finishedAt: number;
  /** Wall-clock seconds the download took (0 when the start was unknown). */
  seconds: number;
  /** Whole-file average, bytes/s (0 when the duration is unknown). */
  avgBps: number;
}

const HISTORY_KEY = 't9.downloads.history.v1';
/** Old rows go only when this many newer ones exist — a real cap, not a timer. */
const HISTORY_CAP = 300;

/** Last path segment of a URL, decoded — the best name we have before the
 *  server tells us the real one. */
function fileNameOf(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return last || u.hostname;
  } catch {
    return url;
  }
}

class DownloadsStore {
  items = $state<DownloadItem[]>([]);
  /**
   * A toast lives five seconds. When a 90 GB link is refused ("the server said
   * no", an expired page, a host that blocks probes) the reason has to stay
   * somewhere the user will look again, so the panel keeps it until dismissed.
   */
  failed = $state<FailedDownload[]>([]);
  /**
   * Finished downloads the panel can still show, oldest at the end. Persisted
   * (localStorage = the webview profile on disk), so the daemon's 15-minute
   * prune cannot erase what the user did yesterday.
   */
  history = $state<DownloadHistoryEntry[]>([]);
  /** The history list is expanded in the panel. */
  showHistory = $state(false);
  /** The slide-up panel is open. */
  open = $state(false);
  /**
   * The daemon answered the last poll.
   *
   * The bytes live in the daemon, not here, so an unreachable daemon freezes
   * every number on the panel — and a frozen 0.0 MB/s looks exactly like a
   * download that died. It usually is not: the app restarts a dead daemon
   * within ~20 s, and the sidecars make the interrupted rows continue from
   * their last byte. This flag is "ek second", not "file gayi".
   */
  reachable = $state(true);
  /** Polling is armed (at least one non-terminal item, or the panel is open). */
  private timer: ReturnType<typeof setInterval> | undefined;

  /**
   * The settings the daemon is actually using (clamped sockets, absolute
   * folder). SQLite is the durable copy; the daemon is told on every boot and
   * on every save, so a daemon restart never forgets what the user chose.
   */
  settings = $state<DownloadSettings>({ ...DEFAULT_SETTINGS });
  settingsLoaded = $state(false);
  savingSettings = $state(false);

  /** Everything the daemon reported, including rows the user hid. */
  private raw: DownloadItem[] = [];
  /** Rows dismissed this session. The daemon keeps its own record. */
  private hidden = new Set<string>();
  /** Previous status per id, so exactly one completion toast fires. */
  private lastStatus = new Map<string, string>();
  private wasReachable = true;

  get activeCount(): number {
    return this.items.filter((i) => i.status === 'running' || i.status === 'paused').length;
  }

  /** Terminal rows still visible — what "clear finished" would remove. */
  get finishedCount(): number {
    return this.items.filter(
      (i) => i.status === 'done' || i.status === 'error' || i.status === 'cancelled'
    ).length;
  }

  toggle(): void {
    this.open = !this.open;
    if (this.open) void this.pushSettings();
    this.syncTimer();
  }

  /**
   * Load the SQLite copy and hand it to the daemon. Called once when the
   * browser view mounts; a daemon that is still starting simply gets the
   * values again on the next `reachable` transition.
   */
  async loadSettings(): Promise<void> {
    if (!isTauri()) {
      this.settingsLoaded = true;
      return;
    }
    try {
      this.settings = await dlSettingsGet();
    } catch {
      /* SQLite unavailable (dev preview): the defaults are still honest */
    }
    this.settingsLoaded = true;
    await this.pushSettings();
  }

  /**
   * Save to SQLite first, then to the daemon. The database is the source of
   * truth: if the daemon is down the choice is not lost, and the next put
   * (panel open, next download, daemon back) applies it.
   */
  async persistSettings(patch: Partial<DownloadSettings>): Promise<void> {
    if (!isTauri()) {
      this.settings = { ...this.settings, ...patch };
      return;
    }
    this.savingSettings = true;
    try {
      this.settings = await dlSettingsSave({ ...this.settings, ...patch });
      await this.pushSettings();
    } catch (err) {
      toast.push('warn', err instanceof Error ? err.message : String(err), 4000);
      throw err;
    } finally {
      this.savingSettings = false;
    }
  }

  private async pushSettings(): Promise<void> {
    if (!isTauri() || !this.settingsLoaded) return;
    try {
      const res = await fetch(`${DAEMON}/v1/dl/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.settings)
      });
      if (res.ok) {
        // The daemon answers with what it resolved (clamped/absolute), so the
        // panel shows the truth rather than the request.
        this.settings = (await res.json()) as DownloadSettings;
      }
    } catch {
      /* daemon down; retried when it comes back or the next download starts */
    }
  }

  /** Ask the daemon to start a multi-segment download. */
  async start(url: string, opts?: { referer?: string }): Promise<void> {
    if (!isTauri()) return;
    try {
      // The socket count / folder are daemon settings, and a start is the
      // moment they must be current: a user who moved the slider expects the
      // next click to use it, not the one after a restart.
      await this.pushSettings();
      const res = await fetch(`${DAEMON}/v1/dl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, referer: opts?.referer ?? null })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `daemon refused the download (${res.status})`);
      }
      // The daemon answers with the row it accepted, so the start notification
      // can carry the real filename and the size it measured. A response with
      // no body still means "accepted" — fall back to the URL's last segment.
      const accepted = (await res.json().catch(() => null)) as DownloadItem | null;
      this.open = true;
      this.syncTimer();
      await this.poll();
      this.notifyStart(accepted, url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failed = [
        {
          id: `failed-${Date.now()}-${this.failed.length}`,
          filename: fileNameOf(url),
          error: message
        },
        ...this.failed
      ].slice(0, 6);
      this.open = true;
      throw new Error(message);
    }
  }

  /** Drop a refused start from the panel. */
  dismissFailed(id: string): void {
    this.failed = this.failed.filter((f) => f.id !== id);
  }

  /**
   * pause / resume / cancel. `resume` is also the Retry button on a failed
   * row: the daemon keeps the `.part` and every byte in it, so resuming is
   * continuing, not restarting. A refusal is shown instead of swallowed -
   * a Retry click that does nothing is how the row looked dead forever.
   */
  act(id: string, action: 'pause' | 'resume' | 'cancel'): void {
    if (!isTauri()) return;
    void fetch(`${DAEMON}/v1/dl/${id}/${action}`, { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          void toast.push('warn', body?.error ?? `download ${action} nahi hua`, 2600);
          return;
        }
        await this.poll();
      })
      .catch(() => {});
  }

  dismiss(id: string): void {
    // Terminal rows only leave the list when asked; the daemon keeps its own
    // record until the file is cleaned.
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status === 'running' || item.status === 'paused') return;
    this.hidden.add(id);
    this.items = this.items.filter((i) => i.id !== id);
  }

  /** Hide every terminal row at once — the × on a long session's list. */
  clearFinished(): void {
    for (const item of this.items) {
      if (item.status !== 'running' && item.status !== 'paused') this.hidden.add(item.id);
    }
    this.items = this.items.filter((i) => i.status === 'running' || i.status === 'paused');
    if (this.items.length === 0) this.syncTimer();
  }

  private async poll(): Promise<void> {
    if (!isTauri()) return;
    try {
      const res = await fetch(`${DAEMON}/v1/dl`, { cache: 'no-store' });
      if (res.ok) {
        const list = (await res.json()) as DownloadItem[];
        this.raw = Array.isArray(list) ? list : [];
        this.noteCompletions(this.raw);
        this.pruneHidden(this.raw);
        this.items = this.raw.filter((i) => !this.hidden.has(i.id));
        this.reachable = true;
        if (!this.wasReachable) {
          // The daemon just came back (or started late). It forgot its
          // in-memory settings, so hand them over again before the next row.
          void this.pushSettings();
        }
        this.wasReachable = true;
      } else {
        this.reachable = false;
        this.wasReachable = false;
      }
    } catch {
      /* daemon not up — the panel says so instead of showing frozen numbers */
      this.reachable = false;
      this.wasReachable = false;
    }
    this.syncTimer();
  }

  /**
   * A finished row is a file the user was waiting for. The panel is often
   * closed by then (the download keeps running in the daemon), so completion
   * has to reach them where they are: one toast, once, and only if they asked
   * for it. A file over 1 GB also gets an OS notification — those are the
   * downloads that finish while the app is in the background.
   */
  private noteCompletions(list: DownloadItem[]): void {
    for (const item of list) {
      const prev = this.lastStatus.get(item.id);
      if (
        item.status === 'done' &&
        prev !== undefined &&
        prev !== 'done' &&
        this.settings.notifyDone
      ) {
        toast.push('cut', `${item.filename} download ho gaya`, 5000);
        if (item.totalBytes >= BIG_DOWNLOAD) {
          void appNotify(
            'Download poora hua',
            `${item.filename} · ${fmtBytes(item.totalBytes)} — Downloads folder me hai`
          ).catch(() => {
            /* a denied toast must not break the queue */
          });
        }
      }
      // Every terminal row enters the durable history exactly once — done,
      // failed or cancelled. It is the only record that survives the daemon's
      // 15-minute prune, and it is what the panel's detail line reads.
      if (item.status !== 'running' && item.status !== 'paused') this.record(item);
      this.lastStatus.set(item.id, item.status);
    }
    for (const id of [...this.lastStatus.keys()]) {
      if (!list.some((i) => i.id === id)) this.lastStatus.delete(id);
    }
  }

  /** Write one terminal row to the durable history (idempotent). */
  private record(item: DownloadItem): void {
    if (this.history.some((h) => h.id === item.id)) return;
    const started = item.startedAt ?? 0;
    const finished = item.finishedAt ?? Date.now();
    const seconds = started > 0 ? Math.max(0, Math.round((finished - started) / 1000)) : 0;
    const avgBps = seconds > 0 && item.totalBytes > 0 ? Math.round(item.totalBytes / seconds) : 0;
    this.history = [
      {
        id: item.id,
        url: item.url,
        filename: item.filename,
        path: item.path,
        bytes: item.totalBytes,
        status: item.status,
        error: item.error,
        startedAt: started,
        finishedAt: finished,
        seconds,
        avgBps
      },
      ...this.history
    ].slice(0, HISTORY_CAP);
    this.persistHistory();
  }

  /** Load the durable history. Called once at boot. */
  loadHistory(): void {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as DownloadHistoryEntry[];
      if (!Array.isArray(parsed)) return;
      this.history = parsed.filter((h) => h && typeof h.id === 'string').slice(0, HISTORY_CAP);
    } catch {
      /* private mode or a corrupted key: an empty history is not a crash */
    }
  }

  private persistHistory(): void {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history));
    } catch {
      /* quota / private mode: this session's rows stay in memory */
    }
  }

  /** The explicit, user-driven way history disappears. */
  clearHistory(): void {
    this.history = [];
    this.persistHistory();
    toast.push('info', 'Download history clear ho gayi');
  }

  /**
   * The download began. Windows' notification centre is the only surface
   * that reaches the user when the panel is behind the editor, so every
   * accepted start gets one line there. Respects the single "notify me"
   * switch the settings row already owns.
   */
  private notifyStart(item: DownloadItem | null, url: string): void {
    if (!this.settings.notifyDone) return;
    const name = item?.filename || fileNameOf(url);
    const size = item && item.totalBytes > 0 ? ` · ${fmtBytes(item.totalBytes)}` : '';
    void appNotify('Download shuru', `${name}${size}`).catch(() => {
      /* see above */
    });
  }

  /** A hidden id that fell out of the daemon's list must not leak forever. */
  private pruneHidden(list: DownloadItem[]): void {
    if (this.hidden.size === 0) return;
    const live = new Set(list.map((i) => i.id));
    for (const id of this.hidden) {
      if (!live.has(id)) this.hidden.delete(id);
    }
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
    this.loadHistory();
    void this.loadSettings();
    void this.poll();
  }
}

export const downloads = new DownloadsStore();
