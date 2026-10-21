<script lang="ts">
  /**
   * A reusable loading container.
   *
   * The only moving part is ONE pseudo-element sweep over the whole wrapper
   * (see `.t9-skeleton` in `app.css`) — not one animation per placeholder.
   * It uses `transform` alone, so the compositor does the work and the main
   * thread stays free for the data that is actually loading.
   *
   * Usage anywhere:
   *
   *   <Skeleton label="Media load ho raha hai…" class="p-3">
   *     <SkeletonBlock shape="line" class="w-1/2" />
   *     <SkeletonBlock class="mt-2 h-24 w-full" />
   *   </Skeleton>
   *
   * The label is announced to screen readers; the placeholders are hidden
   * from them, so assistive tech hears one calm status instead of noise.
   */
  import type { Snippet } from 'svelte';

  let {
    label = 'Loading…',
    class: className = '',
    children
  }: {
    label?: string;
    /** Layout classes for the wrapper (grid, padding, gap …). */
    class?: string;
    children?: Snippet;
  } = $props();
</script>

<div class="t9-skeleton {className}" aria-busy="true">
  <span class="sr-only" role="status">{label}</span>
  {@render children?.()}
</div>
