<script lang="ts">
  import { mode } from '../stores/mode.svelte';

  const ITEMS = [
    {
      id: 'cut',
      label: '7:3 Cut',
      icon: 'M6 4v16M18 4v16M6 12h12'
    },
    {
      id: 'polish',
      label: 'Polish',
      icon: 'M4 7V5h16v2M9 19h6M12 5v14'
    },
    {
      id: 'export',
      label: 'Export',
      icon: 'M12 16V4M7 9l5-5 5 5M4 20h16'
    }
  ] as const;
</script>

<!-- Mode isolation: only the mounted mode's tree exists in RAM.
     Switching mode unmounts this whole rail + the mode body. -->
<nav
  class="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-nc-line bg-nc-panel py-2"
>
  <button
    onclick={() => mode.set('ingest')}
    class="grid h-12 w-12 place-items-center rounded-lg text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt
           {mode.current === 'ingest' ? 'bg-nc-panel-2 text-nc-gold' : ''}"
    title="Ingest & Cloud Brain"
  >
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
    >
      <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
    </svg>
  </button>

  <div class="my-1 h-px w-8 bg-nc-line"></div>

  {#each ITEMS as it (it.id)}
    <button
      onclick={() => mode.set(it.id)}
      class="relative grid h-12 w-12 place-items-center rounded-lg text-nc-mut transition-colors
             hover:bg-nc-panel-2 hover:text-nc-txt
             {mode.current === it.id ? 'bg-nc-panel-2 text-nc-gold' : ''}"
      title={it.label}
    >
      {#if mode.current === it.id}
        <span class="absolute -left-2 top-2 bottom-2 w-[3px] rounded-r bg-nc-gold"></span>
      {/if}
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
      >
        <path d={it.icon} />
      </svg>
    </button>
  {/each}

  <div class="flex-1"></div>

  <div
    class="text-center text-[8px] leading-tight tracking-widest text-nc-mut-2"
    title="Only the mounted mode exists in RAM"
  >
    RAM<br />1 MODE
  </div>
</nav>
