<script lang="ts">
  /**
   * Content sidebar — the resizable panel to the right of the icon rail.
   *
   * Only ONE rail tab is mounted at a time: `{#key cc.railTab}` destroys the
   * outgoing panel's tree rather than hiding it. This is the same rule as
   * Mode-Based Panel Isolation, applied one level down — the media browser
   * and the text library never cost RAM together (AGENTS.md §1).
   */
  import { cc } from "../../stores/cc.svelte";
  import LibraryPanel from "./LibraryPanel.svelte";
  import MediaPanel from "./MediaPanel.svelte";
  import RecordPanel from "./RecordPanel.svelte";
  import TextPanel from "./TextPanel.svelte";

  const TITLES: Record<string, string> = {
    media: "My media",
    record: "Record & create",
    library: "Content library",
    templates: "Templates",
    text: "Text",
    transitions: "Transitions",
  };

  // Drag the right edge to resize — Clipchamp's "Resize panel" separator.
  function startResize(event: PointerEvent) {
    const startX = event.clientX;
    const startW = cc.sidebarWidth;
    const move = (e: PointerEvent) => {
      cc.sidebarWidth = Math.min(460, Math.max(200, startW + (e.clientX - startX)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

{#if cc.sidebarOpen}
  <section
    class="relative flex shrink-0 flex-col border-r border-cc-line bg-cc-surface"
    style="width: {cc.sidebarWidth}px"
    aria-label="Content sidebar"
  >
    <div class="flex h-11 shrink-0 items-center justify-between px-3">
      <span class="text-[13.5px] font-semibold text-cc-text">{TITLES[cc.railTab]}</span>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded text-cc-text-3 hover:bg-cc-tint"
        title="Collapse toolbar"
        onclick={() => (cc.sidebarOpen = false)}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M15 4v16" />
        </svg>
      </button>
    </div>

    <!-- One panel resident at a time. -->
    {#key cc.railTab}
      {#if cc.railTab === "media"}
        <MediaPanel />
      {:else if cc.railTab === "record"}
        <RecordPanel />
      {:else if cc.railTab === "text"}
        <TextPanel />
      {:else if cc.railTab === "library"}
        <LibraryPanel />
      {:else}
        <!-- Templates / Transitions: same shell, catalogue comes later. -->
        <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <div class="grid grid-cols-2 gap-2 opacity-60">
            {#each Array(4) as _, i (i)}
              <div class="h-16 w-24 rounded-md bg-cc-tint"></div>
            {/each}
          </div>
          <p class="text-[12.5px] font-semibold text-cc-text">{TITLES[cc.railTab]}</p>
          <p class="cc-sub">catalogue lands with the cloud chunk</p>
        </div>
      {/if}
    {/key}

    <!-- Resize handle on the panel's right edge. -->
    <div
      class="absolute inset-y-0 -right-[3px] w-[6px] cursor-col-resize hover:bg-cc-purple/50"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      onpointerdown={startResize}
    ></div>
  </section>
{:else}
  <!-- Collapsed: a thin strip with the expand control, like the reference. -->
  <div class="flex w-9 shrink-0 flex-col items-center border-r border-cc-line bg-cc-surface pt-2">
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-cc-text-3 hover:bg-cc-tint"
      title="Expand toolbar"
      onclick={() => (cc.sidebarOpen = true)}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </svg>
    </button>
  </div>
{/if}
