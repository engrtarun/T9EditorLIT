import { fetchUsageState, type KeyState, type UsageResponse } from './cloud';

export type UsageLink = 'loading' | 'ok' | 'outdated' | 'down';
export type UsageTab = 'limits' | 'usage' | 'history' | 'keys';

/** On screen: 8 s. Panel open: 4 s — a ~2 kB loopback response, not a socket. */
const POLL_SLOW_MS = 8000;
const POLL_FAST_MS = 4000;

/**
 * THE USAGE STORE — one source of truth for every API-usage surface.
 *
 * The gauge lives in two places now: the big card on the T9 Cloud panel and
 * a small ring in the editor's tool row, where someone mid-edit wants to
 * know what is left before triggering a transcription. Both read this, and
 * both open the *same* dialog — so there is one poll, one payload and one
 * place that decides what "outdated" means, instead of two components
 * drifting apart.
 *
 * Three outcomes stay separate on purpose, because they are three different
 * truths: the daemon answered (`ok`), it answered but this build predates
 * `GET /v1/usage` (`outdated` — an older t9cloud.exe), or it is not
 * reachable at all (`down`). Collapsing them into one `null` made the UI
 * claim "the daemon is not running" while it was running perfectly well,
 * just without that endpoint.
 *
 * Polling is refcounted: it runs only while at least one surface is on
 * screen, so a screen that shows neither (Home, Export) costs nothing.
 */
class UsageStore {
  usage = $state<UsageResponse | null>(null);
  link = $state<UsageLink>('loading');
  loading = $state(true);
  open = $state(false);
  tab = $state<UsageTab>('limits');

  /** How many surfaces are on screen. Plain (not `$state`): nothing renders it. */
  private subs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  get groq() {
    return this.usage?.services?.['groq'] ?? null;
  }
  get gemini() {
    return this.usage?.services?.['gemini'] ?? null;
  }
  get keys(): KeyState[] {
    return this.usage?.keys ?? [];
  }

  /** `-1` = the provider publishes no such limit; callers draw `—`, never `0%`. */
  get dayPct(): number {
    return this.groq?.requestsUsedPct ?? -1;
  }
  get tokenPct(): number {
    return this.groq?.tokensUsedPct ?? -1;
  }

  /** False until a call has actually been served — "no data", not a confident 0. */
  get hasData(): boolean {
    return !!this.usage && (this.groq?.calls ?? 0) + (this.gemini?.calls ?? 0) > 0;
  }

  async refresh(): Promise<void> {
    const res = await fetchUsageState();
    this.link = res.state;
    if (res.state === 'ok') this.usage = res.usage;
    this.loading = false;
  }

  /** Opening answers immediately instead of after up to 8 s. */
  openDialog(tab?: UsageTab): void {
    if (tab) this.tab = tab;
    this.open = true;
    void this.refresh();
  }

  closeDialog(): void {
    this.open = false;
  }

  /**
   * Called from a component's `$effect` while that surface is on screen;
   * the returned function is the effect's teardown.
   *
   * `arm()` reads `open`, so the effect *tracks* it: opening the panel
   * re-runs each attached surface's effect and the interval steps from 8 s
   * to 4 s. That is the only way "poll harder while open" can be true — an
   * interval built once reads `open` a single time and keeps that first rate
   * forever.
   */
  attach(): () => void {
    this.subs += 1;
    if (this.subs === 1) void this.refresh();
    this.arm();
    return () => {
      this.subs = Math.max(0, this.subs - 1);
      if (this.subs === 0) this.disarm();
    };
  }

  private arm(): void {
    this.disarm();
    if (this.subs === 0) return;
    this.timer = setInterval(() => void this.refresh(), this.open ? POLL_FAST_MS : POLL_SLOW_MS);
  }

  private disarm(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const usageStore = new UsageStore();
