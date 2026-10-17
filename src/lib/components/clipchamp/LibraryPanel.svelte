<script lang="ts">
  /**
   * Content library panel — search, filter chips, Featured, All content.
   *
   * Static layout copy from the REA capture; the category counts (227 shapes,
   * 50 reds…) come from the reference so proportions match while the real
   * asset catalogue lands later.
   */
  const FEATURED = [
    { name: "Shapes", count: "227 items", swatches: ["#b7b3ff", "#a9a5ff", "#c9c6ff", "#9d98ff"] },
    { name: "Red", count: "50 items", swatches: ["#c62828", "#e53935", "#8e0000", "#ff5252"] },
    { name: "Curve", count: "48 items", swatches: ["#1b1f3b", "#e8e0d5", "#3a4a6b", "#d9cfc2"] },
  ];
  const ALL = ["Music", "Annotations", "Frames", "Subscribe"];
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
  <!-- Search + filter, exactly where the reference puts them. -->
  <div class="flex gap-2">
    <div
      class="flex flex-1 items-center gap-2 rounded-md border border-cc-line bg-cc-surface px-2.5
      py-1.5"
    >
      <svg
        width="13"
        height="13"
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
        placeholder="Search"
        class="w-full bg-transparent text-[13px] outline-none
        placeholder:text-cc-text-4"
      />
    </div>
    <button type="button" class="cc-btn px-2" title="Filters">
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M4 7h16M7 12h10M10 17h4" />
      </svg>
    </button>
  </div>

  <div class="flex gap-2">
    <button type="button" class="cc-btn cc-btn-primary rounded-full px-3 py-1 text-[12px]"
      >All</button
    >
    <button type="button" class="cc-btn rounded-full px-3 py-1 text-[12px]">Audio ⌄</button>
    <button type="button" class="cc-btn rounded-full px-3 py-1 text-[12px]">Visuals ⌄</button>
  </div>

  <section class="flex flex-col gap-2">
    <div class="cc-label">Featured</div>
    {#each FEATURED as group (group.name)}
      <button
        type="button"
        class="cc-panel flex items-center gap-3 p-2.5 text-left hover:bg-cc-tint"
      >
        <div class="grid h-12 w-16 shrink-0 grid-cols-4 gap-0.5 overflow-hidden rounded">
          {#each group.swatches as color (color)}
            <span style="background: {color}"></span>
          {/each}
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-semibold text-cc-text">{group.name}</div>
          <div class="cc-sub">{group.count}</div>
        </div>
        <svg
          width="7"
          height="10"
          viewBox="0 0 8 12"
          fill="var(--color-cc-text-4)"
          aria-hidden="true"
        >
          <path d="M1.5 1 6 6l-4.5 5z" />
        </svg>
      </button>
    {/each}
  </section>

  <section class="flex flex-col gap-2">
    <div class="cc-label">All content</div>
    {#each ALL as name (name)}
      <button
        type="button"
        class="cc-panel flex items-center gap-3 p-2.5 text-left hover:bg-cc-tint"
      >
        <div class="h-9 w-14 shrink-0 rounded bg-cc-tint"></div>
        <span class="flex-1 text-[13px] font-semibold text-cc-text">{name}</span>
        <svg
          width="7"
          height="10"
          viewBox="0 0 8 12"
          fill="var(--color-cc-text-4)"
          aria-hidden="true"
        >
          <path d="M1.5 1 6 6l-4.5 5z" />
        </svg>
      </button>
    {/each}
  </section>
</div>
