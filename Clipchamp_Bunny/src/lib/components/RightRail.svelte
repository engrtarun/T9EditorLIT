<script lang="ts">
  import { project } from '../stores/project.svelte';
</script>

<!-- RIGHT RAIL — Clipchamp has a slim right rail (CC Captions). Ours toggles the
     transcript panel and opens the AI fumble inspector. -->
<nav
  class="flex w-[52px] shrink-0 flex-col items-center gap-1 border-l border-nc-line bg-nc-panel py-2"
>
  <button
    onclick={() => (project.showTranscript = !project.showTranscript)}
    class="flex w-[44px] flex-col items-center gap-1 rounded-lg px-1 py-2 text-center transition-colors
           {project.showTranscript
      ? 'bg-nc-panel-2 text-nc-txt'
      : 'text-nc-mut hover:bg-nc-panel-2/60'}"
    title="Transcript panel (captions)"
  >
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      class={project.showTranscript ? 'text-nc-brand' : ''}
    >
      <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M8 11h2M8 14h6M14 11h2" />
    </svg>
    <span class="text-[9px] leading-[11px] font-medium">Transcript</span>
  </button>

  <button
    class="flex w-[44px] flex-col items-center gap-1 rounded-lg px-1 py-2 text-center text-nc-mut transition-colors hover:bg-nc-panel-2/60 hover:text-nc-txt"
    title="AI fumble inspector"
  >
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
    >
      <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
      <path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z" />
    </svg>
    <span class="text-[9px] leading-[11px] font-medium">AI</span>
  </button>

  <div class="flex-1"></div>

  <div class="text-center text-[8px] leading-[10px] tracking-wider text-nc-mut-2">
    {project.cutCount}<br />CUT
  </div>
</nav>
