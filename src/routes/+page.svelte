<script lang="ts">
  /**
   * Application shell — Clipchamp clone.
   *
   * `{#key cc.view}` below does not merely swap which screen is visible: it
   * destroys the outgoing screen's component tree and builds a fresh one, so
   * the WebView releases its DOM. Home and Editor never coexist in RAM, and
   * inside the editor two more `{#key}` blocks (rail tab, editing mode) keep
   * the resident footprint flat. That is the zero-RAM rule from AGENTS.md §1
   * applied at every level, not just at the mode switch.
   */
  import CcTopBar from "$lib/components/clipchamp/CcTopBar.svelte";
  import DropLayer from "$lib/components/clipchamp/DropLayer.svelte";
  import EditorShell from "$lib/components/clipchamp/EditorShell.svelte";
  import HomeScreen from "$lib/components/clipchamp/HomeScreen.svelte";
  import ShortcutsLayer from "$lib/components/clipchamp/ShortcutsLayer.svelte";
  import { cc } from "$lib/stores/cc.svelte";
  import { memory } from "$lib/stores/memory.svelte.ts";

  $effect(() => {
    memory.start();
    return () => memory.stop();
  });
</script>

<div class="cc-shell flex h-screen flex-col overflow-hidden">
  <!-- EditorShell carries its own top bar (mode switcher + RAM meter live
       there); home renders the shared search variant here. -->
  {#if cc.view === "home"}
    <CcTopBar variant="home" />
  {/if}

  {#key cc.view}
    {#if cc.view === "home"}
      <HomeScreen />
    {:else}
      <EditorShell />
    {/if}
  {/key}
</div>

<!--
  Both layers deliberately live OUTSIDE `{#key cc.view}`: the drop listener and
  the single keydown dispatcher must survive a Home ⇄ Editor swap, otherwise
  Space would go dead the moment you come back from the home screen.
-->
<ShortcutsLayer />
<DropLayer />
