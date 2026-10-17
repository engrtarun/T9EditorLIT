<script lang="ts">
  /**
   * Mode 2 — Music & Text, ported into the Clipchamp shell as the
   * right-hand editing panel.
   *
   * Chunk 5 territory. Its real job today is architectural, not visual: it
   * proves the isolation works. Switching to it unmounts the transcript panel
   * entirely rather than merely hiding it, so the RAM meter in the top bar
   * visibly drops. If the footprint does NOT drop on switch, the isolation is
   * broken — that is a bug worth catching now rather than at Chunk 3.
   */
  import { mode } from "../../stores/mode.svelte";

  const upcoming = [
    {
      title: "Background music",
      detail: "Deck with ducking under speech, Apna College / Coder Army level restraint.",
      chunk: "Chunk 5",
    },
    {
      title: "Text & headings",
      detail: "Topic headings and light text overlays matched to the tutorial style.",
      chunk: "Chunk 5",
    },
    {
      title: "Telegram vault",
      detail: "MTProto backup of sources and exports via Rust grammers.",
      chunk: "Chunk 5",
    },
  ];
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 p-3">
  <div class="flex items-center justify-between">
    <span class="cc-label">Music &amp; Text</span>
    <span class="mono text-[10px] text-cc-text-3">switches: {mode.switchCount}</span>
  </div>

  <p class="text-[12px] leading-relaxed text-cc-text-3">
    Watch <strong class="font-semibold text-cc-text">APP</strong> in the top bar while switching —
    this panel arriving should have <em>released</em> the transcript panel's memory.
  </p>

  <ul class="flex flex-col gap-2">
    {#each upcoming as item (item.title)}
      <li class="cc-panel flex items-start gap-2.5 p-2.5">
        <span
          class="mt-0.5 shrink-0 rounded bg-cc-tint px-1.5 py-0.5 text-[10px] font-semibold
          text-cc-text-3"
        >
          {item.chunk}
        </span>
        <div class="min-w-0">
          <div class="text-[12.5px] font-medium text-cc-text">{item.title}</div>
          <div class="text-[11.5px] leading-relaxed text-cc-text-3">{item.detail}</div>
        </div>
      </li>
    {/each}
  </ul>

  <button type="button" class="cc-btn self-start" onclick={() => mode.set("cut")}>
    ← Back to Cut mode
  </button>
</div>
