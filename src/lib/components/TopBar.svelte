<script lang="ts">
  /**
   * Application top bar: identity, mode switcher, source summary, RAM meter.
   *
   * The RAM meter lives here permanently, in every mode — it is the one
   * diagnostic that must never be a tab away.
   */
  import ModeSwitcher from "./ModeSwitcher.svelte";
  import RamMeter from "./RamMeter.svelte";
  import { formatBytes, project } from "../stores/project.svelte";
</script>

<header class="flex h-14 shrink-0 items-center gap-4 border-b border-base-700 bg-base-900 px-4">
  <!-- Identity -->
  <div class="flex items-center gap-2.5">
    <div
      class="flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-bold text-base-950"
      style="background: linear-gradient(135deg, var(--color-nanami-rose), var(--color-nanami-sage))"
      aria-hidden="true"
    >
      T9
    </div>
    <div class="leading-none">
      <div class="text-[13px] font-semibold tracking-tight text-nanami-blush">T9EditorLIT</div>
      <div class="text-[9px] tracking-[0.14em] text-ink-500 uppercase">No overtime</div>
    </div>
  </div>

  <div class="h-6 w-px bg-base-700"></div>

  <ModeSwitcher />

  <div class="flex-1"></div>

  <!-- Source summary -->
  {#if project.info}
    {@const info = project.info}
    <div class="mono flex items-center gap-3 text-[11px] text-ink-300">
      <span title="Duration">{project.durationLabel}</span>
      <span class="text-base-600">|</span>
      <span title="File size on disk">{formatBytes(info.sizeBytes)}</span>
      <span class="text-base-600">|</span>
      <span title="Resolution">
        {info.width}×{info.height}
      </span>
      <span class="text-base-600">|</span>
      <span title="Frame rate">
        {info.fps ? info.fps.toFixed(2) : "—"} fps
      </span>
      {#if !info.hasAudio}
        <span
          class="rounded px-1.5 py-0.5 text-[10px]"
          style="background: var(--color-cut-dim); color: var(--color-cut)"
        >
          no audio — cannot transcribe
        </span>
      {/if}
    </div>
  {/if}

  <div class="h-6 w-px bg-base-700"></div>

  <RamMeter />
</header>
