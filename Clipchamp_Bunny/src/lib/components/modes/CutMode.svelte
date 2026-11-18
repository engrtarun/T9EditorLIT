<script lang="ts">
  import PreviewBar from '../PreviewBar.svelte';
  import MediaPanel from '../media/MediaPanel.svelte';
  import VideoPreview from '../cut/VideoPreview.svelte';
  import TranscriptPanel from '../cut/TranscriptPanel.svelte';
  import WaveTimeline from '../cut/WaveTimeline.svelte';
  import { project } from '../../stores/project.svelte';
  import { player } from '../../stores/player.svelte';
  import { layout } from '../../stores/layout.svelte';

  /**
   * The transport settings are **per project**: the zoom a 40-minute lecture
   * needs is not the zoom a 20-second clip needs. The controls live in three
   * places (preview bar, timeline tool row, keyboard), so watching the four
   * values is safer than remembering to save inside each handler.
   */
  $effect(() => {
    void player.zoom;
    void player.previewRaw;
    void player.loop;
    void player.snap;
    project.noteUiChange();
  });

  /** Clipchamp's `role="separator" aria-label="Resize panel"` — drag the edge. */
  function startResize(e: PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = layout.transcriptWidth;
    const move = (ev: PointerEvent) => layout.setTranscriptWidth(startW - (ev.clientX - startX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
</script>

<!-- 7:3 CUT PANEL — Clipchamp's centre column, but with the transcript panel
     added on the right (our core feature). Bottom timeline spans the full width. -->
<div class="flex min-h-0 min-w-0 flex-1 flex-col">
  <PreviewBar />

  <div class="flex min-h-0 flex-1">
    <!-- Left: "My media" — the one library panel, now that the Media page is gone -->
    <MediaPanel />

    <!-- Left box -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col border-r border-nc-line">
      <VideoPreview />
    </div>

    <!-- resize separator -->
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      title="Drag to resize"
      onpointerdown={startResize}
      class="w-[3px] shrink-0 cursor-col-resize bg-nc-line transition-colors hover:bg-nc-brand/60"
    ></div>

    <!-- Right box -->
    {#if project.showTranscript}
      <TranscriptPanel />
    {/if}
  </div>

  <!-- Bottom box -->
  <WaveTimeline />
</div>
