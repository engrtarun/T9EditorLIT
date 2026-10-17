<script lang="ts">
  /**
   * Mode 2 — Music & Text / pipeline.
   *
   * Chunk 5 territory. Its real job today is architectural, not visual: it
   * proves the isolation works. When you switch from Cut to this mode, the
   * transcript panel's DOM is torn down entirely rather than merely hidden, so
   * the RAM meter in the top bar visibly drops.
   *
   * If the app's footprint does NOT drop on switch, the isolation is not
   * working and that is a bug worth catching now rather than at Chunk 3.
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

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
  <div class="mx-auto w-full max-w-2xl">
    <div class="mb-5 flex items-center gap-3">
      <div
        class="flex h-9 w-9 items-center justify-center rounded-lg border border-base-700 bg-base-900 text-sm"
        aria-hidden="true"
      >
        <span style="color: var(--color-nanami-sage)">♪</span>
      </div>
      <div>
        <h2 class="text-base font-semibold text-nanami-blush">Music &amp; Text</h2>
        <p class="mono text-[11px] text-ink-500">
          mode switches so far: {mode.switchCount}
        </p>
      </div>
    </div>

    <p class="mb-6 text-[13px] leading-relaxed text-ink-300">
      This panel is intentionally almost empty. The important thing to verify right now is the
      number next to <strong class="text-nanami-blush">APP</strong> in the top bar — switching to
      this mode should have <em>released</em> the transcript panel's memory.
    </p>

    <ul class="flex flex-col gap-2">
      {#each upcoming as item (item.title)}
        <li class="panel flex items-start gap-3 p-3">
          <span
            class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
            style="background: var(--color-base-700); color: var(--color-ink-300)"
          >
            {item.chunk}
          </span>
          <div>
            <div class="text-[13px] font-medium text-ink-100">{item.title}</div>
            <div class="text-[12px] leading-relaxed text-ink-500">{item.detail}</div>
          </div>
        </li>
      {/each}
    </ul>

    <button type="button" class="btn mt-6" onclick={() => mode.set("cut")}>
      ← Back to Cut mode
    </button>
  </div>
</div>
