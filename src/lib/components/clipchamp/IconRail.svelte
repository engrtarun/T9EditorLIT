<script lang="ts">
  /**
   * Editor icon rail — Clipchamp's left-most 60 px strip.
   *
   * Selecting a tab swaps the content sidebar beside it. Each tab's panel is
   * mounted inside a `{#key}` in ContentSidebar, so only the selected panel
   * exists in the DOM; the media browser and the text library never coexist.
   */
  import type { RailTab } from "../../stores/cc.svelte";
  import { cc } from "../../stores/cc.svelte";

  type RailItem = { id: RailTab; label: string; path: string };

  // Icon paths are simple line glyphs — no icon library (AGENTS.md §2).
  const ITEMS: RailItem[] = [
    {
      id: "media",
      label: "My media",
      path: "M3 7a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    },
    {
      id: "record",
      label: "Record &\ncreate",
      path: "M4 7.5A1.5 1.5 0 0 1 5.5 6h7A1.5 1.5 0 0 1 14 7.5v9A1.5 1.5 0 0 1 12.5 18h-7A1.5 1.5 0 0 1 4 16.5zM16 10.5l4-2.5v8l-4-2.5z",
    },
    {
      id: "library",
      label: "Content\nlibrary",
      path: "M4 5.5A1.5 1.5 0 0 1 5.5 4h5A1.5 1.5 0 0 1 12 5.5v5A1.5 1.5 0 0 1 10.5 12h-5A1.5 1.5 0 0 1 4 10.5zM12 13.5a1.5 1.5 0 0 1 1.5-1.5h5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5zM14 5.5A1.5 1.5 0 0 1 15.5 4h3A1.5 1.5 0 0 1 20 5.5v3A1.5 1.5 0 0 1 18.5 12h-3A1.5 1.5 0 0 1 14 8.5zM4 15.5A1.5 1.5 0 0 1 5.5 14h3A1.5 1.5 0 0 1 10 15.5v3A1.5 1.5 0 0 1 8.5 20h-3A1.5 1.5 0 0 1 4 18.5z",
    },
    {
      id: "templates",
      label: "Templates",
      path: "M4 6a2 2 0 0 1 2-2h5v7H4zm9-4h5a2 2 0 0 1 2 2v5h-7zM4 13h7v7H6a2 2 0 0 1-2-2zm9 0h7v5a2 2 0 0 1-2 2h-5z",
    },
    {
      id: "text",
      label: "Text",
      path: "M5 6V4.5h14V6h-5.2V19h-3.6V6z",
    },
    {
      id: "transitions",
      label: "Transitions",
      path: "M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v13A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5zM13 5.5A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5z",
    },
    {
      id: "vault",
      label: "Cloud\nVault",
      path: "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10H7v2h10zm-4-4H7v2h10zm0-4H7v2h10z",
    },
    {
      id: "settings",
      label: "Settings",
      path: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm0-8a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1zm0 16a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1zm8-8a1 1 0 1 1 0 2h-2a1 1 0 1 1 0-2zM4 12a1 1 0 1 1 0 2H2a1 1 0 1 1 0-2zm15.07-5.07a1 1 0 0 1 0 1.41l-1.41 1.41a1 1 0 1 1-1.41-1.41l1.41-1.41a1 1 0 0 1 1.41 0zM7.76 16.24a1 1 0 0 1 0 1.41l-1.41 1.41a1 1 0 1 1-1.41-1.41l1.41-1.41a1 1 0 0 1 1.41 0zm11.31-8.53l-1.41 1.41a1 1 0 1 1-1.41-1.41l1.41-1.41a1 1 0 0 1 1.41 0zM7.76 7.76a1 1 0 0 1 0-1.41L6.35 4.94a1 1 0 1 1 1.41-1.41l1.41 1.41a1 1 0 0 1-1.41 1.41z",
    },
  ];
</script>

<div
  class="flex w-[60px] shrink-0 flex-col gap-1 border-r border-cc-line bg-cc-bg px-2 py-2"
  aria-label="Sidebar navigation"
  role="tablist"
  aria-orientation="vertical"
>
  {#each ITEMS as item (item.id)}
    <button
      type="button"
      class="cc-rail-btn"
      role="tab"
      aria-selected={cc.railTab === item.id}
      onclick={() => (cc.railTab = item.id)}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d={item.path} />
      </svg>
      <span class="whitespace-pre-line">{item.label}</span>
    </button>
  {/each}
</div>
