<script lang="ts">
  /**
   * "Text" panel — Plain text, Text styles, Title.
   *
   * Tiles are drag sources onto the timeline in Clipchamp; here they are the
   * same layout with a click that will select a text layer once the text
   * engine lands. The checkerboard is real: it means "this asset has an
   * alpha channel", which is why the styles sit on it in the reference too.
   */
  const STYLES = ["Creator", "Text box", "Pride", "Button", "Bubble", "Retro"];
  const TITLES = ["Typewriter", "Circular", "Groovy", "Fireworks"];

  let selected = $state<string | null>(null);
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
  <section class="flex flex-col gap-2">
    <div class="cc-label">Plain text</div>
    <button
      type="button"
      class="flex h-[86px] w-[96px] items-center justify-center rounded-md bg-black text-[13px]
        font-semibold text-white {selected === 'plain' ? 'ring-2 ring-cc-purple' : ''}"
      onclick={() => (selected = "plain")}
    >
      Text
    </button>
  </section>

  <section class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="cc-label">Text styles</span>
      <button
        type="button"
        class="flex items-center gap-1 text-[12px] font-semibold
        text-cc-purple hover:underline"
      >
        See all
        <svg width="8" height="10" viewBox="0 0 8 12" fill="currentColor" aria-hidden="true">
          <path d="M1.5 1 6 6l-4.5 5z" />
        </svg>
      </button>
    </div>
    <div class="grid grid-cols-2 gap-2">
      {#each STYLES as style (style)}
        <button
          type="button"
          class="cc-checker flex h-[68px] items-center justify-center overflow-hidden rounded-md
            border {selected === style
            ? 'border-cc-purple ring-2 ring-cc-purple/40'
            : 'border-cc-line-soft'}"
          onclick={() => (selected = style)}
        >
          <span
            class="px-1 text-center text-[13px] font-extrabold uppercase tracking-tight
            {style === 'Button'
              ? 'rounded-full border border-black bg-white px-3 py-1 text-[11px] normal-case'
              : ''}
            {style === 'Bubble' ? 'text-[#8ef06a]' : ''}
            {style === 'Retro' ? 'text-[#ff5d5d]' : ''}
            {style === 'Pride' ? 'italic text-[#ffb03a]' : ''}
            {style === 'Creator' || style === 'Text box' ? 'text-black' : ''}"
          >
            {style}
          </span>
        </button>
      {/each}
    </div>
  </section>

  <section class="flex flex-col gap-2">
    <div class="cc-label">Title</div>
    <div class="grid grid-cols-2 gap-2">
      {#each TITLES as title (title)}
        <button
          type="button"
          class="flex h-[76px] items-center justify-center rounded-md bg-black text-[13px]
            font-bold text-white {selected === title ? 'ring-2 ring-cc-purple' : ''}"
          onclick={() => (selected = title)}
        >
          {title}
        </button>
      {/each}
    </div>
  </section>
</div>
