<script lang="ts">
  import PreviewBar from '../PreviewBar.svelte';
  import VideoPreview from '../cut/VideoPreview.svelte';
  import TranscriptPanel from '../cut/TranscriptPanel.svelte';
  import WaveTimeline from '../cut/WaveTimeline.svelte';
  import { project } from '../../stores/project.svelte';
</script>

<!-- 7:3 CUT PANEL — Clipchamp's centre column, but with the transcript panel
     added on the right (our core feature). Bottom timeline spans the full width. -->
<div class="flex min-h-0 min-w-0 flex-1 flex-col">
  <PreviewBar />

  <div class="flex min-h-0 flex-1">
    <!-- Left box -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col border-r border-nc-line">
      <VideoPreview />
    </div>

    <!-- Right box -->
    {#if project.showTranscript}
      <TranscriptPanel />
    {/if}
  </div>

  <!-- Bottom box -->
  <WaveTimeline />
</div>
