<script lang="ts">
  import VideoPreview from '../cut/VideoPreview.svelte';
  import TranscriptPanel from '../cut/TranscriptPanel.svelte';
  import WaveTimeline from '../cut/WaveTimeline.svelte';
</script>

<!-- 7:3 CUT PANEL — the diagram from myneed1.jpg, exactly.
     Left = video preview · Right = transcript ✓/✕ · Bottom = waves + FPS strip -->
<div class="flex min-w-0 flex-1 flex-col">
  <div class="flex min-h-0 flex-1">
    <!-- Left box -->
    <div class="flex min-w-0 flex-1 flex-col border-r border-nc-line">
      <VideoPreview />
    </div>

    <!-- Right box -->
    <TranscriptPanel />
  </div>

  <!-- Bottom box -->
  <WaveTimeline />
</div>
