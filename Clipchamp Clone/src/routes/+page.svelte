<script lang="ts">
  import { editor } from "$lib/editor.svelte";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import MediaBin from "$lib/components/MediaBin.svelte";
  import Preview from "$lib/components/Preview.svelte";
  import Timeline from "$lib/components/Timeline.svelte";
  import Inspector from "$lib/components/Inspector.svelte";
  import Captions from "$lib/components/Captions.svelte";
  import ExportPanel from "$lib/components/ExportPanel.svelte";

  // Seed a two-track project so the scaffold shows a working timeline on load
  // instead of an empty grid. Swap for SQLite-backed loading later.
  if (editor.tracks.length === 0) {
    editor.addTrack("video", "Main");
    editor.addTrack("audio", "Music");
  }

  /** Space = play/pause, S = split, Ctrl+Z = undo. Ignored while typing. */
  function onKeydown(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;

    if (e.code === "Space") {
      e.preventDefault();
      editor.togglePlay();
    } else if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      editor.splitSelected();
    } else if (e.key.toLowerCase() === "z" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.shiftKey ? editor.redo() : editor.undo();
    } else if ((e.key === "Delete" || e.key === "Backspace") && editor.selectedClip) {
      e.preventDefault();
      editor.deleteSelected(e.shiftKey);
    } else if (e.key === "ArrowLeft") {
      editor.seek(editor.playheadSecs - (e.shiftKey ? 5 : 1));
    } else if (e.key === "ArrowRight") {
      editor.seek(editor.playheadSecs + (e.shiftKey ? 5 : 1));
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full flex-col bg-zinc-950">
  <Toolbar />

  <!--
    Mode-based panel isolation (AGENTS.md): {#key} destroys the previous
    component tree on switch, so a heavy panel's state and DOM never linger.
  -->
  {#key editor.mode}
    {#if editor.mode === "edit"}
      <div class="flex min-h-0 flex-1">
        <MediaBin />
        <div class="flex min-w-0 flex-1 flex-col">
          <Preview />
          <Timeline />
        </div>
        <Inspector />
      </div>
    {:else if editor.mode === "captions"}
      <div class="flex min-h-0 flex-1">
        <MediaBin />
        <Captions />
        <Inspector />
      </div>
    {:else}
      <ExportPanel />
    {/if}
  {/key}
</div>
