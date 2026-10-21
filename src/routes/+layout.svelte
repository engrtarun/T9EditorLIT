<script lang="ts">
  import { onMount } from "svelte";
  import "../app.css";

  let { children } = $props();

  onMount(() => {
    /**
     * Drop the boot splash in `src/app.html`.
     *
     * Layout mount is the earliest honest signal that the real UI is on
     * screen, and `remove()` (rather than a `display: none`) hands the nodes
     * back to the heap — a splash should exist for exactly one mount on an
     * 8 GB machine. The CSS in app.html handles the 180 ms fade, so nothing
     * here waits on it: no timer, no rAF, no extra paint pass.
     */
    const splash = document.getElementById("t9-splash");
    if (!splash) return;
    splash.setAttribute("data-leaving", "1");
    window.setTimeout(() => splash.remove(), 200);
  });
</script>

{@render children()}
