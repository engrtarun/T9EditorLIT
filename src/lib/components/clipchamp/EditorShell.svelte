<script lang="ts">
  /**
   * Editor shell — the Clipchamp clone.
   *
   *   top bar · icon rail · content sidebar · stage · timeline · mode panel
   *
   * Two isolation rules are active on this screen:
   *
   *  1. `{#key cc.railTab}` in ContentSidebar — only one rail panel resident.
   *  2. `{#key mode.current}` below — only one editing mode resident, and it
   *     lives in Clipchamp's right-hand properties panel, which is where the
   *     reference app puts contextual controls too.
   *
   * Stage and Timeline are mode-independent: one preview, one track area, no
   * matter which mode is up. That is both what Clipchamp does and what keeps
   * the resident footprint flat across switches.
   */
  import CcTopBar from "./CcTopBar.svelte";
  import ContentSidebar from "./ContentSidebar.svelte";
  import IconRail from "./IconRail.svelte";
  import Stage from "./Stage.svelte";
  import Timeline from "./Timeline.svelte";
  import CutMode from "../modes/CutMode.svelte";
  import PolishMode from "../modes/PolishMode.svelte";
  import ExportMode from "../modes/ExportMode.svelte";
  import { mode } from "../../stores/mode.svelte";
  import { cc } from "../../stores/cc.svelte";

  // Drag the panel's left edge to resize it (the "splitter" handle).
  function startPanelResize(event: PointerEvent) {
    const startX = event.clientX;
    const startW = cc.panelWidth;
    const move = (e: PointerEvent) => {
      // Dragging left (negative delta) widens the panel.
      cc.panelWidth = Math.min(560, Math.max(220, startW - (e.clientX - startX)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
  <CcTopBar variant="editor" />

  <div class="flex min-h-0 flex-1">
    <IconRail />
    <ContentSidebar />

    <!-- Centre: stage over timeline, shared by every mode. -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-cc-sunken">
      <Stage />
      <Timeline />
    </div>

    <!-- Right: the resident editing mode (transcript | music & text | export). -->
    <aside
      class="relative flex shrink-0 flex-col overflow-hidden border-l border-cc-line
        bg-cc-surface"
      style="width: {cc.panelWidth}px"
      aria-label="Editing panel"
    >
      <!-- Drag handle on the panel's left edge. -->
      <div
        class="absolute inset-y-0 -left-[3px] z-20 w-[6px] cursor-col-resize hover:bg-cc-purple/50"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize editing panel"
        onpointerdown={startPanelResize}
      ></div>
      {#key mode.current}
        {#if mode.current === "cut"}
          <CutMode />
        {:else if mode.current === "export"}
          <ExportMode />
        {:else}
          <PolishMode />
        {/if}
      {/key}
    </aside>
  </div>
</div>
