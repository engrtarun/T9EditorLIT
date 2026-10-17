<script lang="ts">
  /**
   * Application shell.
   *
   * The important line is the `{#key mode.current}` block below. It does not
   * merely swap which component is visible — it destroys the outgoing mode's
   * component tree and builds a fresh one. That is what releases its DOM and
   * lets the WebView reclaim the memory, which is the whole reason this app can
   * run on an 8 GB machine.
   */
  import SourceBar from "$lib/components/SourceBar.svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  import CutMode from "$lib/components/modes/CutMode.svelte";
  import PolishMode from "$lib/components/modes/PolishMode.svelte";
  import { memory } from "$lib/stores/memory.svelte.ts";
  import { mode } from "$lib/stores/mode.svelte.ts";

  $effect(() => {
    memory.start();
    return () => memory.stop();
  });
</script>

<div class="flex h-screen flex-col overflow-hidden bg-base-950">
  <TopBar />
  <SourceBar />

  {#key mode.current}
    {#if mode.current === "cut"}
      <CutMode />
    {:else}
      <PolishMode />
    {/if}
  {/key}
</div>
