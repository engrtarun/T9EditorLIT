<script lang="ts">
  /**
   * Mode 1 — Transcript & Cut, ported into the Clipchamp shell as the
   * right-hand editing panel.
   *
   * The preview and the waveform/thumbnails no longer live here: the shell's
   * Stage and Timeline own those surfaces now (Clipchamp puts them there and
   * it is the right call — one preview, one track area, for every mode). What
   * stays mode-specific is the transcript, so that is what this panel holds.
   *
   * Mounted inside `{#key mode.current}` in EditorShell, so switching to
   * Polish tears this DOM down rather than hiding it — the isolation rule
   * from AGENTS.md §1 survives the layout change.
   *
   * Chunk 2 fills the transcript with real cloud-transcribed lines; the
   * structure below is the contract it builds against.
   */
  import { project } from "../../stores/project.svelte";
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3 p-3">
  <div class="flex items-center justify-between">
    <span class="cc-label">Transcript</span>
    <span class="mono text-[10px] text-cc-text-3" title="Shortcuts: X = cut, V = keep">
      X cut · V keep
    </span>
  </div>

  <div class="cc-panel flex min-h-0 flex-1 flex-col overflow-hidden">
    {#if !project.hasMedia}
      <div class="flex flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center">
        <span class="text-[12.5px] font-semibold text-cc-text">Import a video first</span>
        <span class="text-[11.5px] leading-relaxed text-cc-text-3">
          The transcript is transcribed from the source — nothing to show until one is loaded.
        </span>
      </div>
    {:else}
      <!--
        Virtual scroll lands here in Chunk 3. A 2-hour video carries thousands
        of lines; rendering them all would fill the heap, so only the ~30 lines
        inside the viewport are ever in the DOM.
      -->
      <div class="flex flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center">
        <span class="text-[12.5px] text-cc-text-3">transcript appears in Chunk 2</span>
        <span class="mono text-[10px] text-cc-text-4"> Groq Whisper · Gemini flags retakes </span>
      </div>
    {/if}
  </div>
</div>
