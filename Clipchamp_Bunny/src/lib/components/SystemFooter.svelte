<script lang="ts">
  /**
   * The status bar.
   *
   * Five honest readings, one row, no decoration:
   *
   *   · **App**    — the disk the app itself uses (database + cache + logs)
   *   · **Device** — the drive, used / total, with a hairline bar
   *   · **Net**    — bytes per second, down and up, straight from the OS
   *   · **RAM**    — this app's tree and the machine's used / total
   *   · **Clock**  — Delhi's time, date and day; click it for the world clock
   *
   * Every number comes from one Rust call per second (`meters` store) — no
   * polling happens unless a screen actually shows this bar, and nothing is
   * buffered on the way.
   */
  import { meters } from '../stores/meters.svelte';
  import WorldClock from './WorldClock.svelte';
  import { fmtBytes } from '../dashboard';

  /** The India's time zone — the machine may be set to anything. */
  const IST = 'Asia/Kolkata';

  let clockOpen = $state(false);
  /** Ticks once a second so the clock moves. */
  let now = $state(new Date());

  $effect(() => {
    meters.start();
    return () => meters.stop();
  });

  $effect(() => {
    const id = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(id);
  });

  const snap = $derived(meters.snapshot);

  /* ------------------------------------------------------------- formats */

  /** `118 / 476 GB` — the drive. */
  const device = $derived.by(() => {
    const d = snap?.drive;
    if (!d || !d.totalBytes) return { used: '—', total: '', pct: 0 };
    const used = d.totalBytes - d.freeBytes;
    const gb = (b: number) => (b / 1_073_741_824).toFixed(0);
    return {
      used: gb(used),
      total: gb(d.totalBytes),
      pct: Math.max(0, Math.min(100, (used / d.totalBytes) * 100))
    };
  });

  /** `5.1 / 8.0 GB` plus this app's own share. */
  const ram = $derived.by(() => {
    const r = snap?.ram;
    if (!r || !r.totalMb) return { used: '—', total: '', app: '—', pct: 0 };
    return {
      used: (r.usedMb / 1024).toFixed(1),
      total: (r.totalMb / 1024).toFixed(1),
      app: `${r.appMb} MB`,
      pct: r.usedPercent
    };
  });

  /** `4.2 MB/s` — kilobytes below 100 KB/s so the number stays readable. */
  function rate(bps: number): string {
    if (bps >= 1024 * 1024) return `${(bps / 1_048_576).toFixed(1)} MB/s`;
    if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
    return `${bps} B/s`;
  }

  const net = $derived({
    down: snap ? rate(snap.net.downBps) : '—',
    up: snap ? rate(snap.net.upBps) : '—',
    iface: snap?.net.interface ?? ''
  });

  /** `3:25 PM` in Delhi — the 12-hour clock, the way Windows shows it. */
  const clock = $derived.by(() => {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: IST,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
    const parts = fmt.formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const hour = get('hour').replace(/^0/, '');
    return {
      day: `${get('weekday')}, ${get('day')} ${get('month')}`,
      time: `${hour}:${get('minute')} ${get('dayPeriod').toUpperCase()}`
    };
  });

  /** The battery, when the machine has one. */
  const battery = $derived(snap?.battery ?? null);

  /** The bar colour follows the usual traffic-light rule. */
  function tone(pct: number): string {
    if (pct > 90) return 'bg-nc-red';
    if (pct > 75) return 'bg-nc-gold';
    return 'bg-nc-green';
  }

  /**
   * The battery reads the other way round: **low** charge is the bad state.
   *
   * The same rule Windows uses — under 15 % is red, under 40 % is amber.
   */
  function batteryTone(pct: number): string {
    if (pct <= 15) return 'bg-nc-red';
    if (pct <= 40) return 'bg-nc-gold';
    return 'bg-nc-green';
  }
</script>

<!-- One hairline separator between the groups. -->
<div class="flex items-center gap-3">
  <!-- app's own disk usage -->
  <span
    class="flex items-center gap-1.5"
    title="Disk the app itself uses — database, cache and logs"
  >
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="text-nc-mut-2"
      aria-hidden="true"
    >
      <path d="M3 8l9-5 9 5v8l-9 5-9-5z" /><path d="M3 8l9 5 9-5" /><path d="M12 13v8" />
    </svg>
    <span class="text-[11px] text-nc-mut">App</span>
    <span class="font-mono text-[11px] text-nc-txt tabular-nums">
      {snap ? fmtBytes(snap.appStorageBytes) : '—'}
    </span>
  </span>

  <span class="h-3.5 w-px bg-nc-line"></span>

  <!-- the drive -->
  <span class="flex items-center gap-1.5" title="The drive this app lives on">
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="text-nc-mut-2"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="6" rx="1.5" /><rect
        x="3"
        y="13"
        width="18"
        height="6"
        rx="1.5"
      />
      <path d="M7 8h.01M7 16h.01" />
    </svg>
    <span class="text-[11px] text-nc-mut">Device</span>
    <span class="font-mono text-[11px] text-nc-txt tabular-nums">
      {device.used} / {device.total} GB
    </span>
    <span class="relative h-1 w-14 overflow-hidden rounded-full bg-nc-line">
      <span
        class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out {tone(
          device.pct
        )}"
        style="width:{device.pct}%"
      ></span>
    </span>
  </span>

  <span class="h-3.5 w-px bg-nc-line"></span>

  <!-- network -->
  <span
    class="flex items-center gap-1.5"
    title="Real throughput{net.iface
      ? ` on ${net.iface}`
      : ''} — read from the OS interface counters"
  >
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="text-nc-mut-2"
      aria-hidden="true"
    >
      <path d="M12 4v13" /><path d="m6 12 6 6 6-6" />
    </svg>
    <span class="font-mono text-[11px] text-nc-txt tabular-nums">{net.down}</span>
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="ml-1 text-nc-mut-2"
      aria-hidden="true"
    >
      <path d="M12 20V7" /><path d="m6 12 6-6 6 6" />
    </svg>
    <span class="font-mono text-[11px] text-nc-txt tabular-nums">{net.up}</span>
  </span>

  <span class="h-3.5 w-px bg-nc-line"></span>

  <!-- ram -->
  <span
    class="flex items-center gap-1.5"
    title="This app's memory (host + WebView2 renderers) and the machine's RAM"
  >
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="text-nc-mut-2"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="2" /><path
        d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"
      />
    </svg>
    <span class="text-[11px] text-nc-mut">RAM</span>
    <span class="relative h-1 w-14 overflow-hidden rounded-full bg-nc-line">
      <span
        class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out {tone(
          ram.pct
        )}"
        style="width:{ram.pct}%"
      ></span>
    </span>
    <span class="font-mono text-[11px] text-nc-txt tabular-nums">
      {ram.used} / {ram.total} GB
    </span>
    <span class="font-mono text-[11px] text-nc-mut-2 tabular-nums">· app {ram.app}</span>
  </span>

  <div class="flex-1"></div>

  <!-- battery: only on a machine that has one -->
  {#if battery}
    <span class="flex items-center gap-1.5" title="Battery{battery.charging ? ' · charging' : ''}">
      <svg width="20" height="11" viewBox="0 0 26 14" aria-hidden="true" class="text-nc-mut-2">
        <rect
          x="0.6"
          y="0.6"
          width="22"
          height="12.8"
          rx="3"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
          opacity="0.5"
        />
        <rect
          x="23.4"
          y="4.4"
          width="2.2"
          height="5.2"
          rx="1.1"
          fill="currentColor"
          opacity="0.5"
        />
        <rect
          x="2"
          y="2"
          width={Math.max(0.6, (18 * battery.percent) / 100)}
          height="10"
          rx="1.8"
          class={batteryTone(battery.percent)}
        />
      </svg>
      <span class="font-mono text-[11px] text-nc-txt tabular-nums">{battery.percent}%</span>
      {#if battery.charging}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="text-nc-gold"
          aria-label="Charging"
        >
          <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z" />
        </svg>
      {/if}
    </span>

    <span class="h-3.5 w-px bg-nc-line"></span>
  {/if}

  <!-- clock -->
  <button
    onclick={() => (clockOpen = !clockOpen)}
    class="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] text-nc-mut transition-colors duration-150 hover:bg-nc-panel-2 hover:text-nc-txt"
    title="Delhi time — click for the world clock"
    aria-haspopup="dialog"
    aria-expanded={clockOpen}
  >
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="text-nc-mut-2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
    <span class="text-nc-mut-2">{clock.day}</span>
    <span class="font-mono text-nc-txt tabular-nums">{clock.time}</span>
    <span class="text-[10px] text-nc-mut-2">IST</span>
  </button>
</div>

<WorldClock bind:open={clockOpen} />
