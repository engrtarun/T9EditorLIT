<script lang="ts">
  /**
   * One setting row with a dropdown — Format, Resolution and Frame Rate in
   * the new Export screen (the image-approved design).
   *
   * The row is one button (icon · label · value · chevron); clicking opens a
   * menu under it. Options the installed engine cannot honour yet arrive
   * `disabled` + `soon: true`, so the roadmap is visible without the panel
   * ever promising a render it cannot produce (EXPORT.md §3 / §7).
   *
   * A click outside or Escape closes the menu — no focus trap, because the
   * menu is a pick list, not a dialog.
   */
  import type { Snippet } from 'svelte';

  let {
    label,
    value,
    display,
    icon,
    tint = 'text-nc-mut bg-nc-panel-2',
    options,
    soon = false,
    disabled = false,
    title = '',
    onselect
  }: {
    label: string;
    value: string;
    display?: string;
    icon: Snippet;
    /** Accent classes for the icon tile, so each row has its own colour. */
    tint?: string;
    options: Array<{
      value: string;
      label: string;
      note?: string;
      disabled?: boolean;
      soon?: boolean;
    }>;
    /** Chip next to the value: this choice needs a backend update to apply. */
    soon?: boolean;
    disabled?: boolean;
    title?: string;
    onselect: (value: string) => void;
  } = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();

  const selected = $derived(options.find((o) => o.value === value) ?? null);

  $effect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open = false;
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  });

  function pick(v: string) {
    open = false;
    onselect(v);
  }
</script>

<div class="relative" bind:this={root}>
  <button
    type="button"
    {disabled}
    {title}
    aria-expanded={open}
    aria-haspopup="listbox"
    onclick={() => (open = !open)}
    class="nc-hover-lift group flex w-full items-center gap-3.5 rounded-2xl border px-3.5 py-3 text-left transition-all duration-150
           {open
      ? 'border-nc-brand/60 bg-nc-panel-2 shadow-[0_0_0_3px_rgba(77,141,255,0.12)]'
      : 'border-nc-line/80 bg-nc-panel/80 hover:border-nc-line-2 hover:shadow-lg hover:shadow-black/25'}
           disabled:cursor-not-allowed disabled:opacity-50"
  >
    <span
      class="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/5 {tint}"
      aria-hidden="true"
    >
      {@render icon()}
    </span>
    <span class="min-w-0 flex-1">
      <span
        class="block text-[10.5px] font-semibold uppercase tracking-wider leading-tight text-nc-mut"
        >{label}</span
      >
      <span class="mt-0.5 block truncate text-[14px] font-semibold leading-tight text-nc-txt">
        {display ?? selected?.label ?? value}
      </span>
    </span>
    {#if soon}
      <span
        class="shrink-0 rounded-md border border-nc-amber/30 bg-nc-amber/12 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-nc-amber"
        title="Ye choice tab apply hogi jab engine me aa jaye (EXPORT.md)"
      >
        SOON
      </span>
    {/if}
    <svg
      viewBox="0 0 24 24"
      class="h-4 w-4 shrink-0 text-nc-mut-2 transition-all duration-200 {open
        ? 'rotate-180 text-nc-brand'
        : 'group-hover:text-nc-mut'}"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  </button>

  {#if open}
    <ul
      role="listbox"
      class="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-2xl border border-nc-line bg-nc-panel-2 shadow-2xl shadow-black/60"
    >
      {#each options as opt (opt.value)}
        <li role="option" aria-selected={opt.value === value}>
          <button
            type="button"
            disabled={opt.disabled}
            onclick={() => pick(opt.value)}
            class="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[12.5px] transition-colors
                   {opt.disabled
              ? 'cursor-not-allowed text-nc-mut-2'
              : opt.value === value
                ? 'bg-nc-brand/12 font-semibold text-nc-txt'
                : 'text-nc-mut hover:bg-nc-panel hover:text-nc-txt'}"
          >
            <span class="min-w-0 flex-1 truncate">
              {opt.label}
              {#if opt.note}<span class="text-nc-mut-2"> · {opt.note}</span>{/if}
            </span>
            {#if opt.soon}
              <span
                class="shrink-0 rounded bg-nc-amber/15 px-1 py-0.5 text-[9px] font-bold text-nc-amber"
              >
                SOON
              </span>
            {/if}
            {#if opt.value === value}
              <svg
                viewBox="0 0 24 24"
                class="h-3.5 w-3.5 shrink-0 text-nc-brand"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m5 13 4 4L19 7" />
              </svg>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
