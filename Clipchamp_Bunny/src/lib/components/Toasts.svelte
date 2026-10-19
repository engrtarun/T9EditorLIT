<script lang="ts">
  import { toast, type ToastKind } from '../stores/toast.svelte';

  const STYLE: Record<ToastKind, string> = {
    info: 'border-nc-line-2 bg-nc-panel-2 text-nc-txt',
    cut: 'border-nc-red/50 bg-nc-red/12 text-nc-red',
    keep: 'border-nc-green/50 bg-nc-green/12 text-nc-green',
    split: 'border-nc-gold/50 bg-nc-gold/12 text-nc-gold',
    warn: 'border-nc-red/50 bg-nc-panel-2 text-nc-txt'
  };
</script>

<!-- Micro feedback — every cut, keep and split confirms instantly -->
<div
  class="pointer-events-none fixed bottom-6 left-1/2 z-[350] flex -translate-x-1/2 flex-col items-center gap-1.5"
>
  {#each toast.items as t (t.id)}
    <div
      class="rounded-lg border px-3 py-1.5 text-[11px] font-medium shadow-xl backdrop-blur-sm {STYLE[
        t.kind
      ]}"
    >
      {t.text}
    </div>
  {/each}
</div>
