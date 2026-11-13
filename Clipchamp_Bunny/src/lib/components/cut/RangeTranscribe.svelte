<script lang="ts">
  import { project } from '../../stores/project.svelte';
  import { parseTimecode } from '../../utils';

  /**
   * "Sirf is hissa": the honest way to buy a part of a long file.
   *
   * Whisper is called per ~5-minute chunk, so the range picks chunks, not
   * seconds. An empty box means the edge of the file (start / end), which
   * makes "10:00 se aage" a one-field question instead of two.
   *
   * The estimate is deliberately the chunk count, not a fake exactness: a
   * 12:00-14:00 range really does buy 12:00-15:00 of audio.
   */
  let from = $state('');
  let to = $state('');
  let error = $state('');

  function submit(): void {
    const duration = project.media?.durationSecs ?? 0;
    const a = from.trim() ? parseTimecode(from) : 0;
    const b = to.trim() ? parseTimecode(to) : duration;
    if (a === null || b === null) {
      error = 'Time 1:30 ya 95 jaise likho (ghante:minute:second bhi chalega).';
      return;
    }
    if (!(b > a)) {
      error = 'Akhiri time shuru se bada hona chahiye.';
      return;
    }
    error = '';
    void project.transcribeRange(a, b);
  }
</script>

<div class="mt-3 rounded-lg border border-nc-line bg-nc-panel-2/50 p-2 text-left">
  <p class="text-[10.5px] leading-snug text-nc-mut">
    Sirf ek hissa chahiye? Whisper 5-minute chunks me kaam karta hai — jo chunk is range ko touch
    karta hai, wahi transcribe hoga.
  </p>
  <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
    <input
      bind:value={from}
      onkeydown={(e) => e.key === 'Enter' && submit()}
      placeholder="0:00"
      aria-label="Shuru ka time"
      class="w-[62px] rounded border border-nc-line-2 bg-nc-panel px-1.5 py-0.5 font-mono
             text-[11px] text-nc-txt placeholder:text-nc-mut-2"
    />
    <span class="text-[10px] text-nc-mut-2">se</span>
    <input
      bind:value={to}
      onkeydown={(e) => e.key === 'Enter' && submit()}
      placeholder="end"
      aria-label="Akhiri time"
      class="w-[62px] rounded border border-nc-line-2 bg-nc-panel px-1.5 py-0.5 font-mono
             text-[11px] text-nc-txt placeholder:text-nc-mut-2"
    />
    <span class="text-[10px] text-nc-mut-2">tak</span>
    <button
      onclick={submit}
      disabled={project.planRunning}
      class="rounded border border-nc-brand/50 px-2 py-0.5 text-[10.5px] font-semibold
             text-nc-brand transition-colors hover:bg-nc-brand/10 disabled:cursor-progress
             disabled:opacity-60"
    >
      Sirf ye hissa
    </button>
  </div>
  {#if error}
    <p class="mt-1 text-[10px] leading-snug text-nc-red">{error}</p>
  {/if}
</div>
