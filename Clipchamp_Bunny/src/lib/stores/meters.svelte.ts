import { isTauri, systemSnapshot } from '../ipc';
import type { SystemSnapshot } from '../types';

/**
 * The live system meters.
 *
 * One IPC call per second, one set of numbers out: RAM (this app and the
 * machine), the drive, the app's own disk usage and the network throughput.
 *
 * The polling **only runs while a screen asks for it** — `start()` on mount,
 * `stop()` on unmount — so an app nobody is looking at costs nothing. The
 * next call is scheduled after the previous one finished, so a slow probe can
 * never pile up into a queue.
 */
class MetersStore {
  /** The last reading, or null before the first one lands. */
  snapshot = $state<SystemSnapshot | null>(null);
  /** The last failure, kept so the UI can say "—" instead of a wrong number. */
  error = $state<string | null>(null);

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** How many screens want the heartbeat. */
  private users = 0;

  private async tick(): Promise<void> {
    if (this.users === 0) return;
    try {
      this.snapshot = await systemSnapshot();
      this.error = null;
    } catch (e) {
      // Keep the last good reading — a meter that blanks out is worse than
      // one that is a second old.
      this.error = e instanceof Error ? e.message : String(e);
    }
    if (this.users === 0) return;
    this.timer = setTimeout(() => void this.tick(), 1000);
  }

  /**
   * Start the one-second heartbeat.
   *
   * Reference counted, so two screens showing meters do not fight over it and
   * the last one to leave turns it off.
   */
  start(): void {
    this.users++;
    if (!isTauri() || this.users > 1) return;
    void this.tick();
  }

  /** Stop the heartbeat. Safe to call when it is not running. */
  stop(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** True while the heartbeat is running. */
  get live(): boolean {
    return this.users > 0;
  }
}

export const meters = new MetersStore();
