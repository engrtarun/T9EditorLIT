<script lang="ts">
  /**
   * One placeholder shape inside a <Skeleton> wrapper.
   *
   * Shape only sets the default radius; size and spacing stay with Tailwind
   * classes so the same primitive fits cards, rows, panels and text lines.
   * The colour is the shared `--t9-skeleton-base` token, which is mixed from
   * the brand palette in `app.css`.
   */
  let {
    shape = 'block',
    class: className = '',
    style = ''
  }: {
    shape?: 'block' | 'line' | 'circle';
    class?: string;
    /** Escape hatch for a one-off width/height (e.g. `width: 42%`). */
    style?: string;
  } = $props();
</script>

<div
  class="t9-skeleton-block t9-skeleton-{shape} {className}"
  style={style || undefined}
  aria-hidden="true"
></div>
