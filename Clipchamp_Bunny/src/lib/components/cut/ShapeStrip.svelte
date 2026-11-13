<script lang="ts">
  /**
   * The video's shape, and the gaps a silence pass may cut (cases 35, 40).
   *
   * The strip is built from timings the transcript already has: windowed
   * speech density and pacing, plus a small CTA vocabulary. It is a read, not
   * a decision — but the intro/outro/CTA ranges it produces are keep-zones,
   * and the auto-cut pass subtracts them so the hook and the call to action
   * survive.
   */
  import { project } from '../../stores/project.svelte';
  import { player } from '../../stores/player.svelte';
  import { SHAPE_CLASS, SHAPE_LABEL, shapeSummary, type ShapeKind } from '../../shape';
  import { gapSummary } from '../../silence-map';

  const KINDS: ShapeKind[] = ['intro', 'teach', 'demo', 'story', 'outro'];

  const shape = $derived(project.shape);
  const total = $derived(Math.max(1, project.durationSec));
  const gaps = $derived(project.gapStats);
  const legend = $derived(shapeSummary(shape));

  function seek(start: number) {
    player.seek(Math.max(0, start));
  }
</script>

{#if shape.length}
  <section class="shrink-0 border-b border-nc-line bg-nc-panel-2/30 px-3 py-1.5">
    <div class="flex items-center gap-2">
      <span class="text-[9px] font-bold tracking-widest text-nc-mut-2">SHAPE</span>
      <span class="min-w-0 flex-1 truncate text-[9.5px] text-nc-mut" title={legend}>{legend}</span>
      {#if gaps}
        <span class="shrink-0 font-mono text-[9px] text-nc-mut-2" title="Silence tiers">
          {gapSummary(gaps)}
        </span>
      {/if}
    </div>

    <div class="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-nc-bg">
      {#each shape as block (block.start)}
        <button
          onclick={() => seek(block.start)}
          class="h-full min-w-[2px] transition-[filter] hover:brightness-125 {SHAPE_CLASS[
            block.kind
          ]}"
          style="width:{Math.max(0.4, ((block.end - block.start) / total) * 100)}%"
          title="{SHAPE_LABEL[block.kind]} · {Math.round(block.start)}s–{Math.round(block.end)}s ·
            {Math.round(block.density * 100)}% speech"
        ></button>
      {/each}
    </div>

    <div class="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[8.5px] text-nc-mut-2">
      {#each KINDS as kind (kind)}
        {#if shape.some((s) => s.kind === kind)}
          <span class="inline-flex items-center gap-1">
            <span class="inline-block h-1.5 w-1.5 rounded-full {SHAPE_CLASS[kind]}"></span>
            {SHAPE_LABEL[kind]}
          </span>
        {/if}
      {/each}
    </div>
  </section>
{/if}
