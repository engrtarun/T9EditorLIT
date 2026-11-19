<script lang="ts">
  /**
   * The After Effects "rolling text reveal" the user pointed at: every letter
   * sits in its own 11 px mask and rolls upward through it, one column after
   * the next, while the word after it stays still.
   *
   * It is per LETTER, not one block of text sliding: `MOTION` in the reference
   * shows different letters caught at different heights mid-roll. Each column
   * is a clipping box, the old glyph flies out of the top and the new one
   * rises from below with a small stagger (`i * 24 ms`), so the word reads as
   * a rolling reveal instead of a cross-fade.
   *
   * The cells are monospaced on purpose: a proportional font would change
   * every column's width when the glyph changes (`I` -> `A`), and the whole
   * label would jitter on each tick.
   */
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';

  let {
    words,
    every = 2200,
    cell = 6
  }: { words: readonly string[]; every?: number; cell?: number } = $props();

  let index = $state(0);

  onMount(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => {
      index = (index + 1) % words.length;
    }, every);
    return () => clearInterval(timer);
  });

  /** Every word pads to the longest one, so the columns never reflow. */
  const columns = $derived(Math.max(...words.map((w) => w.length)));
  const letters = $derived([...words[index].padStart(columns)]);
</script>

<span class="inline-flex items-center" aria-hidden="true">
  {#each letters as ch, i (i)}
    <span
      class="relative inline-block h-[11px] overflow-hidden align-bottom"
      style="width:{cell}px"
    >
      {#key `${index}:${i}`}
        <span
          class="absolute inset-0 flex items-center justify-center font-mono text-[9.5px] leading-none font-semibold"
          in:fly={{ y: 9, duration: 260, delay: i * 24 }}
          out:fly={{ y: -9, duration: 200, delay: i * 24 }}
        >
          {ch === ' ' ? '\u00A0' : ch}
        </span>
      {/key}
    </span>
  {/each}
</span>
