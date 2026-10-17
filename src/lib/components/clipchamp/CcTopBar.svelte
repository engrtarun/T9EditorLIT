<script lang="ts">
  /**
   * Clipchamp-style top bar.
   *
   * Two variants, one per screen:
   *   • home    — search box in the middle (Clipchamp's template search)
   *   • editor  — project title, then the two T9 readouts that must never be
   *               a tab away: the mode switcher and the live RAM meter.
   *
   * The RAM meter stays here in every mode on purpose — see AGENTS.md §4.
   */
  import ModeSwitcher from "../ModeSwitcher.svelte";
  import RamMeter from "../RamMeter.svelte";
  import { cc } from "../../stores/cc.svelte";

  let { variant = "home" }: { variant?: "home" | "editor" } = $props();
</script>

<header class="flex h-12 shrink-0 items-center gap-3 border-b border-cc-line bg-cc-bg px-3">
  <!-- App waffle — opens the home screen. -->
  <button
    type="button"
    class="flex h-8 w-8 items-center justify-center rounded-md text-cc-text-3 hover:bg-cc-tint"
    title="Home"
    onclick={() => cc.goHome()}
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      {#each [2, 7, 12] as y (y)}
        {#each [2, 7, 12] as x (x)}
          <circle cx={x} cy={y} r="1.4" />
        {/each}
      {/each}
    </svg>
    <span class="sr-only">Home</span>
  </button>

  <!-- Identity: Clipchamp's stacked-plates mark, in the real purple ramp. -->
  <button type="button" class="flex items-center gap-2" onclick={() => cc.goHome()}>
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 6.2 12 3.4v3.4L3 9.6z" fill="var(--color-cc-purple)" />
      <path d="M3 10.4 12 7.6v3.4L3 13.8z" fill="var(--color-cc-purple-3)" />
      <path d="M13.2 8.7 17.6 7.3v3.4l-4.4 1.4z" fill="var(--color-cc-lilac)" />
    </svg>
    <span class="text-[15px] font-semibold tracking-tight text-cc-text">T9EditorLIT</span>
  </button>

  {#if variant === "home"}
    <!-- Template search, centred like Clipchamp's. -->
    <div
      class="mx-auto flex w-full max-w-md items-center gap-2 rounded-md border border-cc-line
        bg-cc-surface px-3 py-1.5"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-cc-text-4)"
        stroke-width="2"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        placeholder="Search templates"
        class="w-full bg-transparent text-[13px] text-cc-text outline-none
          placeholder:text-cc-text-4"
      />
    </div>
  {:else}
    <!-- Project title with the rename caret. -->
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md border border-cc-line bg-cc-surface px-2.5
        py-1 text-[13px] font-semibold text-cc-text hover:bg-cc-tint"
      title="Rename project"
    >
      {cc.projectName}
      <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <path d="M2 4.2 6 8l4-3.8z" />
      </svg>
    </button>

    <!-- Cloud backup status (Clipchamp shows this next to the title). -->
    <span class="text-cc-text-4" title="Saved to this device">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <path d="M7 18a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17 18z" />
        <path d="m9.5 14 1.8 1.8 3.4-3.6" />
      </svg>
    </span>

    <div class="flex-1"></div>

    <!-- T9's own HUD, sized to sit inside the 48 px bar rather than over it. -->
    <div class="flex items-center gap-3 rounded-md border border-cc-line bg-cc-surface px-3 py-1">
      <ModeSwitcher compact />
      <span class="h-5 w-px bg-cc-line"></span>
      <RamMeter compact />
    </div>
  {/if}
</header>
