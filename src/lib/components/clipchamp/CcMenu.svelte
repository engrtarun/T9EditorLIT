<script lang="ts">
  /**
   * Fluent-style popover menu — the container for the project-title menu,
   * the cloud-backup menu and the "…" overflow menus on media rows.
   *
   * Positioning is delegated to the caller: the trigger sits inside a
   * `relative` wrapper and this element is absolutely placed beneath it,
   * which is how the source popup anchors (`data-popper-placement=
   * "bottom-start"` in resource_Clipchamp/singleFiles/fileRenameer.html).
   * That avoids measuring — no layout read, no scroll listener, nothing
   * that can desync from the trigger.
   *
   * Open state stays in the parent so the trigger can reflect `aria-expanded`
   * and the menu can hand control back (e.g. when Rename swaps the body for
   * an inline input).
   */
  import type { Snippet } from "svelte";

  let {
    align = "start",
    label,
    onclose,
    children,
  }: {
    /** Which edge lines up with the trigger. */
    align?: "start" | "end";
    /** Accessible name for the menu itself. */
    label: string;
    onclose: () => void;
    children: Snippet;
  } = $props();

  let root: HTMLElement | null = $state(null);

  // Fluent closes on any key whose `defaultPrevented` was already set by a
  // child (Escape inside the rename field), plus plain outside clicks.
  function onPointerDown(event: PointerEvent): void {
    if (root && !root.contains(event.target as Node)) onclose();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onclose();
    }
  }
</script>

<svelte:window onpointerdown={onPointerDown} onkeydown={onKeydown} />

<div
  class="cc-menu"
  class:right-0={align === "end"}
  class:left-0={align === "start"}
  role="menu"
  aria-label={label}
  bind:this={root}
>
  {@render children()}
</div>
