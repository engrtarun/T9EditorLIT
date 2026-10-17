<script lang="ts">
  /**
   * Live RAM meter.
   *
   * Two separate numbers, because they answer different questions:
   *   • APP   — what this app is costing you right now (the thing we control)
   *   • RAM   — how full the machine already is (the thing we survive on)
   *
   * On an 8 GB box that is ~80% occupied before we even launch, the second
   * number is the early-warning signal: if it climbs while APP stays flat,
   * something outside this app is eating the machine.
   */
  import { formatRam, memory } from "../stores/memory.svelte.ts";

  const appColor = (pct: number) =>
    pct >= 70 ? "var(--color-cut)" : pct >= 40 ? "var(--color-keep)" : "var(--color-nanami-teal)";

  let systemPct = $derived(memory.stats?.usedPercent ?? 0);
  let appPct = $derived(
    memory.stats && memory.stats.totalMb > 0
      ? (memory.stats.appMb / memory.stats.totalMb) * 100
      : 0,
  );
</script>

<div class="flex items-center gap-3" title="Memory: this app vs. the whole machine">
  <!-- System-wide usage bar -->
  <div class="flex flex-col gap-1">
    <span class="panel-label">RAM</span>
    <div class="h-1.5 w-28 overflow-hidden rounded-full bg-base-700">
      <div
        class="h-full rounded-full transition-[width] duration-300 ease-out"
        style="width: {systemPct.toFixed(1)}%; background: {systemPct >= 85
          ? 'var(--color-cut)'
          : systemPct >= 70
            ? 'var(--color-keep)'
            : 'var(--color-nanami-teal)'}"
      ></div>
    </div>
    <span class="mono text-[10px] text-ink-500">
      {#if memory.stats}
        {formatRam(memory.stats.usedMb)} / {formatRam(memory.stats.totalMb)}
        <span class="text-ink-300">· free {formatRam(memory.stats.availableMb)}</span>
      {:else if memory.error}
        <span style="color: var(--color-cut)">unavailable</span>
      {:else}
        reading…
      {/if}
    </span>
  </div>

  <!-- This app's own footprint -->
  <div
    class="flex items-baseline gap-1.5 rounded-md border border-base-700 bg-base-850 px-2 py-1"
    title="T9EditorLIT resident memory (Rust host + WebView2 renderers)"
  >
    <span class="panel-label">APP</span>
    <span class="mono text-sm font-semibold" style="color: {appColor(appPct)}">
      {memory.stats ? formatRam(memory.stats.appMb) : "—"}
    </span>
  </div>
</div>
