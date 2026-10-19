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
   *
   * `compact` flattens the whole readout to one line so it fits inside the
   * Clipchamp shell's 48 px top bar without pushing its height up — the meter
   * must stay visible, but it does not get to resize the chrome either.
   *
   * Colours are the semantic keep / review / cut tokens, so the bar reads the
   * same in every theme rather than needing a palette of its own.
   */
  import { formatRam, memory } from "../stores/memory.svelte.ts";

  let { compact = false }: { compact?: boolean } = $props();

  /** Green while comfortable, amber approaching the limit, red past it. */
  const levelColor = (pct: number) =>
    pct >= 85
      ? "var(--color-cc-cut)"
      : pct >= 70
        ? "var(--color-cc-review)"
        : "var(--color-cc-keep)";

  /** APP is judged on a lower scale — it is a slice of the whole machine. */
  const appColor = (pct: number) =>
    pct >= 70
      ? "var(--color-cc-cut)"
      : pct >= 40
        ? "var(--color-cc-review)"
        : "var(--color-cc-keep)";

  let systemPct = $derived(memory.stats?.usedPercent ?? 0);
  let appPct = $derived(
    memory.stats && memory.stats.totalMb > 0
      ? (memory.stats.appMb / memory.stats.totalMb) * 100
      : 0,
  );
</script>

{#if compact}
  <!-- One-line form: label, bar, figures — all inside the top bar's height. -->
  <div class="flex items-center gap-2" title="Memory: this app vs. the whole machine">
    <span class="panel-label">RAM</span>
    <div class="h-1.5 w-24 overflow-hidden rounded-full bg-cc-line">
      <div
        class="h-full rounded-full transition-[width] duration-300 ease-out"
        style="width: {systemPct.toFixed(1)}%; background: {levelColor(systemPct)}"
      ></div>
    </div>
    <span class="mono text-[10px] text-cc-text-4">
      {#if memory.stats}
        {formatRam(memory.stats.usedMb)} / {formatRam(memory.stats.totalMb)}
      {:else if memory.error}
        <span style="color: var(--color-cc-cut)">unavailable</span>
      {:else}
        reading…
      {/if}
    </span>
    <span
      class="mono rounded border border-cc-line bg-cc-sunken px-1.5 py-0.5 text-[11px]
        font-semibold"
      title="T9EditorLIT resident memory (Rust host + WebView2 renderers)"
    >
      <span class="panel-label">APP</span>
      <span style="color: {appColor(appPct)}"
        >{memory.stats ? formatRam(memory.stats.appMb) : "—"}</span
      >
    </span>
  </div>
{:else}
  <div class="flex items-center gap-3" title="Memory: this app vs. the whole machine">
    <!-- System-wide usage bar -->
    <div class="flex flex-col gap-1">
      <span class="panel-label">RAM</span>
      <div class="h-1.5 w-28 overflow-hidden rounded-full bg-cc-line">
        <div
          class="h-full rounded-full transition-[width] duration-300 ease-out"
          style="width: {systemPct.toFixed(1)}%; background: {levelColor(systemPct)}"
        ></div>
      </div>
      <span class="mono text-[10px] text-cc-text-4">
        {#if memory.stats}
          {formatRam(memory.stats.usedMb)} / {formatRam(memory.stats.totalMb)}
          <span class="text-cc-text-2">· free {formatRam(memory.stats.availableMb)}</span>
        {:else if memory.error}
          <span style="color: var(--color-cc-cut)">unavailable</span>
        {:else}
          reading…
        {/if}
      </span>
    </div>

    <!-- This app's own footprint -->
    <div
      class="flex items-baseline gap-1.5 rounded-md border border-cc-line bg-cc-sunken px-2 py-1"
      title="T9EditorLIT resident memory (Rust host + WebView2 renderers)"
    >
      <span class="panel-label">APP</span>
      <span class="mono text-sm font-semibold" style="color: {appColor(appPct)}">
        {memory.stats ? formatRam(memory.stats.appMb) : "—"}
      </span>
    </div>
  </div>
{/if}
