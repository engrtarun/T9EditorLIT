<script lang="ts">
  /**
   * Mode switcher — the control that drives Mode-Based Panel Isolation.
   *
   * Clicking a mode destroys the other mode's component tree entirely. Svelte
   * unmounts the DOM and the WebView is free to collect it, which is what keeps
   * the transcript panel and the music/text panel from ever coexisting in RAM.
   *
   * `compact` drops the hint line so the switch is a single row — the form the
   * Clipchamp top bar uses, where vertical space is 48 px and not one more.
   *
   * Colours come from the `--color-cc-*` namespace, so this control follows
   * whichever theme is active instead of carrying its own palette.
   */
  import { MODES, mode } from "../stores/mode.svelte.ts";
  import { shortcuts } from "../stores/shortcuts.svelte";

  let { compact = false }: { compact?: boolean } = $props();

  /** Ctrl + 1/2/3 jump straight to a mode — registered centrally, not here. */
  $effect(() => {
    const un = [
      shortcuts.bind("modeCut", () => mode.set("cut")),
      shortcuts.bind("modePolish", () => mode.set("polish")),
      shortcuts.bind("modeExport", () => mode.set("export")),
    ];
    return () => un.forEach((fn) => fn());
  });
</script>

<nav class="flex items-center gap-1 rounded-md border border-cc-line bg-cc-sunken p-1">
  {#each MODES as m (m.id)}
    {@const active = mode.current === m.id}
    <button
      type="button"
      class="group relative rounded px-3 py-1 text-left transition-colors duration-150
        {active ? 'bg-cc-surface' : 'hover:bg-cc-tint'}"
      aria-current={active ? "page" : undefined}
      title={m.resident}
      onclick={() => mode.set(m.id)}
    >
      <span
        class="block text-[13px] font-semibold leading-tight
          {active ? 'text-cc-text' : 'text-cc-text-2 group-hover:text-cc-text'}"
      >
        {m.label}
      </span>
      {#if !compact}
        <span class="block text-[9px] leading-tight tracking-wide text-cc-text-4">{m.hint}</span>
      {/if}
      {#if active}
        <span class="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-cc-purple"></span>
      {/if}
    </button>
  {/each}
</nav>
