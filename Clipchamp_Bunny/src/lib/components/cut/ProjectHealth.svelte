<script lang="ts">
  /**
   * Source health — the import gate's report, rendered as a card.
   *
   * Cases 27-38 all answer the same question: "what will this file do to the
   * edit later?" A container quirk, a variable frame rate, a colour tag, an
   * A/V offset and a 5 GB screen recording are all visible in one local probe
   * — before the user has spent twenty minutes cutting.
   *
   * Exactly one machine repair exists today (a lossless remux), and the card
   * says so. Everything else is advice: the original bytes are never touched
   * and nothing is decided on the user's behalf.
   */
  import { toast } from '../../stores/toast.svelte';
  import { project } from '../../stores/project.svelte';
  import {
    asrPercent,
    formatBytes,
    hasAction,
    issueIcon,
    layoutLabel,
    overlayAdvice,
    severityClass,
    sortedIssues,
    sourceSummary
  } from '../../media-report';
  import { generationWarning } from '../../encode-count';

  let open = $state(true);
  let repairing = $state(false);
  let repaired = $state('');

  const report = $derived(project.mediaReport);
  const issues = $derived(sortedIssues(report));
  const summary = $derived(sourceSummary(report));
  const asrShare = $derived(asrPercent(report));
  const layout = $derived(project.layout);
  const warning = $derived(generationWarning(project.encodes));

  async function repair() {
    if (repairing) return;
    repairing = true;
    try {
      const out = await project.runRemux();
      if (out) {
        repaired = out;
        toast.push('info', 'Lossless remux ready — original file waisi hi hai.');
      }
    } catch (e) {
      toast.push('warn', `Remux failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      repairing = false;
    }
  }
</script>

{#if report || warning}
  <section class="shrink-0 border-b border-nc-line bg-nc-panel-2/40">
    <button
      onclick={() => (open = !open)}
      class="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      aria-expanded={open}
    >
      <span class="text-[9px] font-bold tracking-widest text-nc-mut-2">SOURCE</span>
      <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-nc-mut">
        {summary || 'measured'}
      </span>
      {#if issues.length}
        <span
          class="shrink-0 rounded bg-nc-gold/10 px-1.5 py-0.5 font-mono text-[9px] text-nc-gold"
        >
          {issues.length}
        </span>
      {:else if report}
        <span
          class="shrink-0 rounded bg-nc-green/10 px-1.5 py-0.5 font-mono text-[9px] text-nc-green"
        >
          clean
        </span>
      {/if}
      <span class="text-[9px] text-nc-mut-2">{open ? '▾' : '▸'}</span>
    </button>

    {#if open}
      <div class="space-y-1.5 px-3 pb-2">
        {#if asrShare !== null && report}
          <p class="font-mono text-[9.5px] leading-snug text-nc-mut-2">
            ASR copy {formatBytes(report.asr_copy_bytes ?? 0)} · {asrShare.toFixed(2)}% of the
            source — itni hi file API tak jaati hai.
          </p>
        {/if}

        {#each issues as issue (issue.code)}
          <div class="rounded border px-2 py-1 {severityClass(issue.severity)}">
            <div class="flex items-start gap-1.5">
              <span class="mt-[1px] text-[10px]">{issueIcon(issue.code)}</span>
              <div class="min-w-0 flex-1">
                <p class="text-[10.5px] font-semibold leading-snug">{issue.title}</p>
                <p class="mt-0.5 text-[9.5px] leading-snug opacity-80">{issue.detail}</p>
                {#if issue.fix}
                  <p class="mt-0.5 text-[9.5px] leading-snug opacity-70">{issue.fix}</p>
                {/if}
              </div>
            </div>
          </div>
        {/each}

        {#if report && hasAction(report) && project.sourcePath}
          <button
            onclick={repair}
            disabled={repairing}
            class="w-full rounded border border-nc-brand/50 bg-nc-brand/10 px-2 py-1 text-[10px]
                   font-semibold text-nc-brand transition-colors hover:bg-nc-brand/20 disabled:opacity-50"
          >
            {repairing ? 'Remux chal raha hai…' : 'Lossless remux copy banao'}
          </button>
        {/if}

        {#if repaired}
          <p class="truncate font-mono text-[9px] text-nc-green" title={repaired}>
            ✓ {repaired}
          </p>
        {/if}

        {#if layoutLabel(layout)}
          <p class="text-[9.5px] leading-snug text-nc-mut">
            Layout: <span class="text-nc-txt">{layoutLabel(layout)}</span>
          </p>
          {#if overlayAdvice(layout)}
            <p class="text-[9.5px] leading-snug text-nc-mut-2">{overlayAdvice(layout)}</p>
          {/if}
        {/if}

        {#if warning}
          <p
            class="rounded border border-nc-gold/40 bg-nc-gold/10 px-2 py-1 text-[9.5px] leading-snug text-nc-gold"
          >
            {warning}
          </p>
        {/if}
      </div>
    {/if}
  </section>
{/if}
