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
   */
  import { MODES, mode } from "../stores/mode.svelte.ts";

  let { compact = false }: { compact?: boolean } = $props();

  const onKeydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    // Don't hijack shortcuts while typing in a field.
    if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
    if (target?.isContentEditable) return;

    // Ctrl+1 / Ctrl+2 jump straight to a mode.
    if (event.ctrlKey && (event.key === "1" || event.key === "2")) {
      event.preventDefault();
      const target2 = MODES.find((m) => m.id === (event.key === "1" ? "cut" : "polish"));
      if (target2) mode.set(target2.id);
    }
  };
</script>

<svelte:window onkeydown={onKeydown} />

<nav class="flex items-center gap-1 rounded-md border border-base-700 bg-base-850 p-1">
  {#each MODES as m (m.id)}
    {@const active = mode.current === m.id}
    <button
      type="button"
      class="group relative rounded px-3 py-1 text-left transition-colors duration-150
        {active ? 'bg-base-700' : 'hover:bg-base-800'}"
      aria-current={active ? "page" : undefined}
      title={m.resident}
      onclick={() => mode.set(m.id)}
    >
      <span
        class="block text-[13px] font-semibold leading-tight
          {active ? 'text-nanami-blush' : 'text-ink-300 group-hover:text-ink-100'}"
      >
        {m.label}
      </span>
      {#if !compact}
        <span class="block text-[9px] leading-tight tracking-wide text-ink-500">{m.hint}</span>
      {/if}
      {#if active}
        <span
          class="absolute inset-x-1.5 -bottom-px h-px rounded-full"
          style="background: var(--color-nanami-rose)"
        ></span>
      {/if}
    </button>
  {/each}
</nav>
