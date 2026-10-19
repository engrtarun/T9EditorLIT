<script lang="ts">
  import { getMemoryStats, isTauri, measureNetworkSpeed, systemDetails } from '../ipc';
  import type { MemoryStats, SystemDetails } from '../types';

  /**
   * The honesty meter. On an 8 GB box that is already ~80% busy, the user must
   * always be able to see what this app is costing them — RAM, CPU, network
   * throughput and disk headroom — without opening Task Manager.
   */
  let stats = $state<MemoryStats | null>(null);
  let details = $state<SystemDetails | null>(null);
  let mbps = $state<number | null>(null);
  let measuring = $state(false);
  let open = $state(false);

  const inTauri = isTauri();

  /** Browser fallback: coarse, but honest about being coarse. */
  async function browserMemory(): Promise<MemoryStats> {
    const totalGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 0;
    const totalMb = Math.round(totalGb * 1024);
    const heap = (
      performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
    ).memory;
    const usedMb = heap ? Math.round(heap.usedJSHeapSize / 1_048_576) : 0;
    return {
      totalMb,
      usedMb,
      availableMb: Math.max(0, totalMb - usedMb),
      appMb: usedMb,
      usedPercent: totalMb ? (usedMb / totalMb) * 100 : 0
    };
  }

  // Poll RAM every 1.5 s — cheap, and it is the number people care about.
  $effect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!alive) return;
      try {
        stats = inTauri ? await getMemoryStats() : await browserMemory();
        if (open && inTauri) details = await systemDetails();
      } catch {
        /* keep the last good reading */
      }
      timer = setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  });

  async function measure() {
    if (measuring) return;
    measuring = true;
    mbps = await measureNetworkSpeed();
    measuring = false;
  }

  $effect(() => {
    if (open) {
      void measure();
      if (inTauri) void systemDetails().then((d) => (details = d));
    }
  });

  const ramPct = $derived(stats?.usedPercent ?? 0);
  const ramBar = $derived(Math.min(100, ramPct));
  const appPctOfRam = $derived(stats?.totalMb ? (stats.appMb / stats.totalMb) * 100 : 0);
  const uptime = $derived(
    details
      ? `${Math.floor(details.uptimeHours)}h ${Math.round((details.uptimeHours % 1) * 60)}m`
      : '—'
  );
</script>

<!-- ============ top-bar chip ============ -->
<button
  onclick={() => (open = !open)}
  class="mr-1 flex items-center gap-2 rounded-lg border border-nc-line bg-nc-panel-2 px-2.5 py-1 text-[11px] transition-colors hover:border-nc-gold/40"
  title="RAM · this app · network — click for full PC details"
>
  <!-- RAM -->
  <span class="flex items-center gap-1.5">
    <span class="text-[9px] font-bold tracking-wider text-nc-mut">RAM</span>
    <span class="relative h-1.5 w-12 overflow-hidden rounded-full bg-nc-line">
      <span
        class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500
               {ramPct > 85 ? 'bg-nc-red' : ramPct > 70 ? 'bg-nc-gold' : 'bg-nc-green'}"
        style="width:{ramBar}%"
      ></span>
    </span>
    <span class="font-mono text-nc-txt">
      {(stats?.usedMb ?? 0) / 1024 >= 1
        ? `${((stats?.usedMb ?? 0) / 1024).toFixed(1)}`
        : `${stats?.usedMb ?? 0}`}
      <span class="text-nc-mut-2">/{((stats?.totalMb ?? 0) / 1024).toFixed(0)}G</span>
    </span>
  </span>

  <span class="h-3.5 w-px bg-nc-line"></span>

  <!-- this app -->
  <span class="flex items-center gap-1 font-mono" title="What Nanami Cut is costing right now">
    <span class="h-2 w-1.5 rounded-sm bg-nc-gold"></span>
    <span class="text-nc-gold">{stats?.appMb ?? 0}</span>
    <span class="text-nc-mut-2">MB</span>
  </span>

  <span class="h-3.5 w-px bg-nc-line"></span>

  <!-- network -->
  <span class="flex items-center gap-1 font-mono" title="Real download throughput">
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      class="text-nc-mut"
    >
      <path d="M12 4v14M6 12l6 6 6-6" />
    </svg>
    <span class={mbps ? 'text-nc-txt' : 'text-nc-mut-2'}>
      {measuring ? '…' : mbps ? mbps.toFixed(1) : '—'}
    </span>
    <span class="text-nc-mut-2">MB/s</span>
  </span>
</button>

<!-- ============ details popover ============ -->
{#if open}
  <button
    class="fixed inset-0 z-[190] cursor-default"
    aria-label="Close"
    onclick={() => (open = false)}
  ></button>
  <div
    class="fixed right-3 z-[200] w-[380px] rounded-xl border border-nc-line-2 bg-[#1E1E29] p-4 shadow-2xl"
  >
    <div class="mb-3 flex items-center gap-2">
      <span
        class="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-nc-gold to-nc-gold-dim text-[12px] font-black text-nc-bg"
        >7</span
      >
      <h3 class="text-[12px] font-bold tracking-wider">PC DETAILS</h3>
      <div class="flex-1"></div>
      <span class="rounded bg-nc-panel-2 px-1.5 py-0.5 text-[9px] text-nc-mut">
        {inTauri ? 'live' : 'browser'}
      </span>
    </div>

    {#if details}
      <dl class="space-y-2.5 text-[11px]">
        <div class="flex gap-2">
          <dt class="w-16 shrink-0 text-nc-mut">OS</dt>
          <dd class="min-w-0 flex-1 truncate">
            {details.osName} <span class="text-nc-mut-2">({details.osVersion})</span>
          </dd>
        </div>
        <div class="flex gap-2">
          <dt class="w-16 shrink-0 text-nc-mut">Host</dt>
          <dd class="min-w-0 flex-1 truncate font-mono">{details.hostName}</dd>
        </div>
        <div class="flex gap-2">
          <dt class="w-16 shrink-0 text-nc-mut">Uptime</dt>
          <dd class="min-w-0 flex-1 font-mono">{uptime}</dd>
        </div>

        <div class="border-t border-nc-line pt-2.5">
          <div class="flex items-baseline gap-2">
            <dt class="w-16 shrink-0 text-nc-mut">CPU</dt>
            <dd class="min-w-0 flex-1 truncate">{details.cpuBrand}</dd>
          </div>
          <div class="mt-1 flex items-center gap-2 pl-[72px]">
            <span class="font-mono text-[10px] text-nc-mut-2">
              {details.cpuCores}c/{details.cpuThreads}t · {details.cpuFrequencyMhz} MHz
            </span>
            <span class="relative h-1.5 flex-1 overflow-hidden rounded-full bg-nc-line">
              <span
                class="absolute inset-y-0 left-0 rounded-full bg-nc-green transition-[width] duration-500"
                style="width:{Math.min(100, details.cpuUsagePercent)}%"
              ></span>
            </span>
            <span class="font-mono text-[10px] text-nc-txt"
              >{details.cpuUsagePercent.toFixed(0)}%</span
            >
          </div>
        </div>

        <div class="border-t border-nc-line pt-2.5">
          <div class="flex items-baseline gap-2">
            <dt class="w-16 shrink-0 text-nc-mut">RAM</dt>
            <dd class="min-w-0 flex-1">
              <span class="font-mono">{details.ramUsedGb.toFixed(1)}</span>
              <span class="text-nc-mut-2"> / {details.ramTotalGb.toFixed(1)} GB</span>
            </dd>
          </div>
          <div class="mt-1 flex items-center gap-2 pl-[72px]">
            <span class="relative h-1.5 flex-1 overflow-hidden rounded-full bg-nc-line">
              <span
                class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500
                       {ramPct > 85 ? 'bg-nc-red' : ramPct > 70 ? 'bg-nc-gold' : 'bg-nc-green'}"
                style="width:{ramBar}%"
              ></span>
            </span>
            <span class="font-mono text-[10px] text-nc-txt">{ramPct.toFixed(0)}%</span>
          </div>
          <div class="mt-1 pl-[72px] font-mono text-[10px] text-nc-mut-2">
            {details.ramAvailableGb.toFixed(1)} GB available
          </div>
        </div>

        <div class="flex gap-2 border-t border-nc-line pt-2.5">
          <dt class="w-16 shrink-0 text-nc-mut">This app</dt>
          <dd class="min-w-0 flex-1 font-mono">
            {details.appMemoryMb} MB
            <span class="text-nc-mut-2"
              >· {appPctOfRam.toFixed(1)}% of RAM · CPU {details.appCpuPercent.toFixed(1)}%</span
            >
          </dd>
        </div>

        <div class="flex gap-2">
          <dt class="w-16 shrink-0 text-nc-mut">Network</dt>
          <dd class="min-w-0 flex-1 font-mono">
            {mbps ? `↓ ${mbps.toFixed(2)} MB/s` : '—'}
            <button onclick={measure} class="ml-1 text-[10px] text-nc-gold hover:underline"
              >retest</button
            >
          </dd>
        </div>

        <div class="border-t border-nc-line pt-2.5">
          <dt class="mb-1.5 text-nc-mut">Storage</dt>
          <div class="space-y-1.5">
            {#each details.disks as d (d.mountPoint)}
              <div class="flex items-center gap-2">
                <span class="w-10 shrink-0 truncate font-mono text-[10px]">{d.mountPoint}</span>
                <span class="relative h-1.5 flex-1 overflow-hidden rounded-full bg-nc-line">
                  <span
                    class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500
                           {d.usedPercent > 90
                      ? 'bg-nc-red'
                      : d.usedPercent > 75
                        ? 'bg-nc-gold'
                        : 'bg-nc-green'}"
                    style="width:{Math.min(100, d.usedPercent)}%"
                  ></span>
                </span>
                <span class="w-24 shrink-0 text-right font-mono text-[10px] text-nc-mut">
                  {d.availableGb.toFixed(0)}/{d.totalGb.toFixed(0)} GB
                </span>
              </div>
            {/each}
          </div>
        </div>
      </dl>
    {:else}
      <p class="py-6 text-center text-[11px] text-nc-mut">
        {inTauri
          ? 'Reading…'
          : 'PC details need the desktop app. In the browser only RAM is available.'}
      </p>
    {/if}
  </div>
{/if}
