<script lang="ts">
  import { project } from '../../stores/project.svelte';
  import { player } from '../../stores/player.svelte';
  import { layout } from '../../stores/layout.svelte';
  import { isTauri } from '../../ipc';
  import { fmtShort } from '../../utils';
  import type { LineFlag, TranscriptLine } from '../../types';

  /* Virtual scroll constants — a 2-hour transcript can be 20k lines.
     Only ~30 rows ever exist in the DOM, so RAM stays flat. */
  const ROW_H = 46;
  const OVERSCAN = 6;

  type Filter = 'all' | 'flagged' | 'cut';
  let filter = $state<Filter>('all');
  let scrollTop = $state(0);
  let viewportH = $state(640);
  let scroller: HTMLDivElement | null = $state(null);

  const view = $derived.by(() => {
    // `orderedLines` is the final-video order — dragging a clip on the
    // timeline reorders these rows live.
    const src = project.orderedLines.length ? project.orderedLines : project.lines;
    if (filter === 'flagged') return src.filter((l) => l.flag !== 'none');
    if (filter === 'cut') return src.filter((l) => l.keep === 'cut');
    return src;
  });

  const cursorPos = $derived.by(() => {
    const cur = project.lines[project.cursor];
    if (!cur) return 0;
    const i = view.findIndex((l) => l.id === cur.id);
    return i >= 0 ? i : 0;
  });

  const startIdx = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN));
  const endIdx = $derived(
    Math.min(view.length, startIdx + Math.ceil(viewportH / ROW_H) + OVERSCAN * 2)
  );
  const slice = $derived(view.slice(startIdx, endIdx));
  const padTop = $derived(startIdx * ROW_H);
  const padBottom = $derived(Math.max(0, (view.length - endIdx) * ROW_H));

  const FILTERS: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'flagged', label: 'AI Flagged' },
    { id: 'cut', label: 'Cut' }
  ];

  const FLAG_LABEL: Record<LineFlag, string> = {
    none: '',
    fumble: 'AI Fumble',
    repeat: 'AI Repeat',
    'wrong-example': 'AI Wrong Example',
    silence: 'Silence'
  };

  const FLAG_CHIP: Record<LineFlag, string> = {
    none: '',
    fumble: 'border-nc-red/40 bg-nc-red/10 text-nc-red',
    repeat: 'border-nc-red/40 bg-nc-red/10 text-nc-red',
    'wrong-example': 'border-nc-red/40 bg-nc-red/10 text-nc-red',
    silence: 'border-nc-mut-2/40 bg-nc-panel-2 text-nc-mut'
  };

  /** Restart the flag chip's pop animation whenever the flag it shows changes. */
  function flagFlash(node: HTMLElement): { destroy: () => void } {
    const anim = node.animate(
      [
        { transform: 'scale(0.6)', opacity: 0 },
        { transform: 'scale(1.18)', opacity: 1, offset: 0.3 },
        { transform: 'scale(1)', opacity: 1, offset: 0.5 }
      ],
      { duration: 2400, easing: 'ease-out', fill: 'forwards' }
    );
    return { destroy: () => anim.cancel() };
  }

  /* Live "kab se chal raha hai" clock.
     Splitting the audio reports no progress of its own — the Rust call just
     returns when it is done — so a ticking clock is the only honest evidence
     that the run is alive rather than hung. */
  let now = $state(Date.now());
  let runStart = 0;
  $effect(() => {
    if (project.pipeline === null) {
      runStart = 0;
      return;
    }
    if (!runStart) runStart = Date.now();
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  const elapsed = $derived(runStart ? fmtShort((now - runStart) / 1000) : '');

  function jump(line: TranscriptLine) {
    // A transcript line belongs to the main source: previewing an extra clip
    // would seek the wrong video, so jump back to the main cut first.
    project.activateClip(null);
    project.cursor = project.lines.findIndex((l) => l.id === line.id);
    player.seek(line.startSec);
  }
  function toggle(line: TranscriptLine) {
    project.toggleLine(line.id);
  }

  // Keep the keyboard cursor visible without the user scrolling.
  $effect(() => {
    const p = cursorPos;
    const el = scroller;
    if (!el) return;
    const y = p * ROW_H;
    if (y < el.scrollTop + ROW_H || y > el.scrollTop + el.clientHeight - ROW_H * 2) {
      el.scrollTo({ top: Math.max(0, y - el.clientHeight / 2), behavior: 'smooth' });
    }
  });

  // When playback moves the cursor, follow it only if the user is not scrolling.
  $effect(() => {
    const p = cursorPos;
    const el = scroller;
    if (!el) return;
    const y = p * ROW_H;
    if (y >= el.scrollTop && y <= el.scrollTop + el.clientHeight - ROW_H * 2) return;
    el.scrollTo({ top: Math.max(0, y - el.clientHeight / 2), behavior: 'smooth' });
  });
</script>

<!-- TRANSCRIPT PANEL (right box of the diagram) -->
<aside
  data-focus="panel"
  tabindex="-1"
  class="flex min-h-0 shrink-0 flex-col border-l border-nc-line bg-nc-panel outline-none"
  style="width:{layout.transcriptWidth}px"
>
  <div class="flex h-11 shrink-0 items-center gap-2 border-b border-nc-line px-3">
    <h2 class="text-xs font-bold tracking-wider">TRANSCRIPT</h2>
    <span class="rounded bg-nc-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-nc-mut"
      >{view.length} lines</span
    >
    <span class="rounded bg-nc-green/10 px-1.5 py-0.5 font-mono text-[10px] text-nc-green"
      >✓ {project.keptCount}</span
    >
    <span class="rounded bg-nc-red/10 px-1.5 py-0.5 font-mono text-[10px] text-nc-red"
      >✕ {project.cutCount}</span
    >
    {#if project.selectedIds.length}
      <span class="rounded bg-nc-brand/15 px-1.5 py-0.5 font-mono text-[10px] text-nc-brand"
        >{project.selectedIds.length} selected</span
      >
    {/if}
  </div>

  <div class="flex h-8 shrink-0 items-center gap-1 border-b border-nc-line px-2">
    {#each FILTERS as f (f.id)}
      <button
        onclick={() => (filter = f.id)}
        class="rounded px-2 py-0.5 text-[10px] font-medium
               {filter === f.id
          ? 'bg-nc-brand text-nc-bg'
          : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
      >
        {f.label}
      </button>
    {/each}
    <div class="flex-1"></div>
    <span class="text-[9px] tracking-widest text-nc-mut-2">X CUT · V KEEP · ↑↓</span>
  </div>

  <!-- virtualised window -->
  <div
    bind:this={scroller}
    bind:clientHeight={viewportH}
    onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
    class="nc-scroll min-h-0 flex-1"
  >
    <div style="height:{padTop}px"></div>

    <!--
      Live run status. Shown *above* the rows so the user keeps reading the
      transcript that already exists while autocorrect/AI flags finish.
    -->
    {#if project.pipeline && view.length > 0}
      <div class="border-b border-nc-line bg-nc-panel-2/70 px-3 py-2">
        <div class="flex items-center justify-between gap-2">
          <span class="truncate text-[11px] text-nc-txt">{project.pipeline.stage}</span>
          <span class="shrink-0 font-mono text-[10px] text-nc-mut"
            >{elapsed} · {Math.round(project.pipeline.fraction * 100)}%</span
          >
        </div>
        <div class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-nc-panel">
          <div
            class="h-full rounded-full bg-nc-brand transition-[width] duration-300"
            style="width:{Math.max(3, Math.round(project.pipeline.fraction * 100))}%"
          ></div>
        </div>
        {#if project.pipeline.lastLine}
          <p class="mt-1.5 truncate text-[10px] italic text-nc-mut-2">
            “{project.pipeline.lastLine}”
          </p>
        {/if}
      </div>
    {/if}

    <!--
      A run that saved its Whisper output but failed later leaves real rows
      plus a reason. Offer the cheap retry: the words are already paid for.
    -->
    {#if !project.pipeline && project.loadError && view.length > 0}
      <div class="border-b border-nc-red/30 bg-nc-red/5 px-3 py-2">
        <p class="text-[11px] leading-relaxed text-nc-red">{project.loadError}</p>
        <button
          onclick={() => void project.refineTranscript()}
          class="mt-1.5 rounded border border-nc-red/40 px-2 py-1 text-[10.5px] font-semibold
                 text-nc-red transition-colors hover:bg-nc-red/10"
        >
          Autocorrect + AI flags dobara chalao
        </button>
        <span class="ml-2 text-[10px] text-nc-mut-2">Whisper dobara nahi chalega.</span>
      </div>
    {/if}
    {#each slice as line, si (line.id)}
      {@const idx = startIdx + si}
      {@const isCursor = idx === cursorPos}
      {@const cut = line.keep === 'cut'}
      <div
        style="height:{ROW_H}px"
        class="group relative flex items-center gap-2 border-b border-nc-line/60 px-2 transition-colors
               {isCursor ? 'bg-nc-brand/8' : 'hover:bg-nc-panel-2'}
               {project.isSelected(line.id) ? 'bg-nc-brand/12' : ''}"
      >
        {#if isCursor}
          <span class="absolute inset-y-0 left-0 w-[3px] bg-nc-brand"></span>
        {/if}

        <button
          onclick={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              project.toggleSelect(line.id);
              return;
            }
            jump(line);
          }}
          class="flex min-w-0 flex-1 items-start gap-2 text-left"
          title="Jump preview here · Ctrl+click to multi-select"
        >
          <span class="mt-[2px] w-[66px] shrink-0 font-mono text-[9px] leading-4 text-nc-mut-2">
            <span class="block">{fmtShort(line.startSec)}</span>
            <span class="block text-nc-mut-2/70">– {fmtShort(line.endSec)}</span>
          </span>
          <span class="min-w-0 flex-1">
            <span
              class="line-clamp-2 text-xs leading-4 {cut
                ? 'nc-slash text-nc-mut line-through decoration-nc-red/70'
                : 'text-nc-txt'}"
            >
              {line.text}
            </span>
            {#if line.flag !== 'none'}
              <span
                use:flagFlash
                class="mt-0.5 inline-block rounded border px-1 py-[1px] text-[8px] font-bold tracking-wider
                       {FLAG_CHIP[line.flag]}"
              >
                {FLAG_LABEL[line.flag]}
                {line.confidence < 0.6 ? ` · ${(line.confidence * 100) | 0}%` : ''}
              </span>
            {/if}
          </span>
        </button>

        <div class="flex shrink-0 items-center gap-1">
          <button
            onclick={() => project.setLine(line.id, 'keep')}
            class="grid h-6 w-6 place-items-center rounded border transition-colors
                   {line.keep === 'keep'
              ? 'border-nc-green bg-nc-green/15 text-nc-green'
              : 'border-nc-line-2 text-nc-mut-2 hover:border-nc-green hover:text-nc-green'}"
            title="Keep ✓ (V)"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
            >
              <path d="M4 12l5 5L20 6" />
            </svg>
          </button>
          <button
            onclick={() => toggle(line)}
            class="grid h-6 w-6 place-items-center rounded border transition-colors
                   {line.keep === 'cut'
              ? 'border-nc-red bg-nc-red/15 text-nc-red'
              : 'border-nc-line-2 text-nc-mut-2 hover:border-nc-red hover:text-nc-red'}"
            title="Cut ✕ (X)"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
            >
              <path d="M5 5l14 14M19 5L5 19" />
            </svg>
          </button>
        </div>
      </div>
    {/each}
    <div style="height:{padBottom}px"></div>

    {#if view.length === 0}
      <!--
        No lines at all (as opposed to "this filter is empty"): the import
        never asked the cloud for a transcript. Offer it — the user's click
        is the permission; nothing is called on its own.
      -->
      {#if project.pipeline}
        <!--
          The user pressed the button: show what the daemon is really doing.
          Chunks finished, lines written so far, and the newest line — the
          three honest answers to "kitna ban gaya?".
        -->
        <div class="p-5">
          <p class="text-xs font-semibold text-nc-txt">{project.pipeline.stage}</p>
          <div class="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-nc-panel-2">
            <div
              class="h-full rounded-full bg-nc-brand transition-[width] duration-300"
              style="width:{Math.max(3, Math.round(project.pipeline.fraction * 100))}%"
            ></div>
          </div>
          <div class="mt-2 flex items-center justify-between font-mono text-[10px] text-nc-mut">
            <span>{elapsed} · {Math.round(project.pipeline.fraction * 100)}%</span>
            {#if project.pipeline.total}
              <span>{project.pipeline.completed ?? 0}/{project.pipeline.total}</span>
            {:else if project.pipeline.lines !== undefined}
              <span>{project.pipeline.lines} lines</span>
            {/if}
          </div>
          {#if project.pipeline.lines}
            <p class="mt-2 text-[11px] text-nc-mut">
              {project.pipeline.lines} transcript lines ban chuki hain
            </p>
          {/if}
          {#if project.pipeline.lastLine}
            <p
              class="mt-3 border-l-2 border-nc-brand/40 pl-2 text-left text-[11px] leading-relaxed
                     text-nc-mut-2 italic"
            >
              “{project.pipeline.lastLine}”
            </p>
          {/if}
          <p class="mt-3 text-[10px] leading-relaxed text-nc-mut-2">
            Lines aate hi panel me dikhengi — poore hone ka intezaar nahi.
          </p>
        </div>
      {:else if project.lines.length === 0}
        <!--
          No lines at all (as opposed to "this filter is empty"): the import
          never asked the cloud for a transcript. Offer it — the user's click
          is the permission; nothing is called on its own.
        -->
        <div class="p-6 text-center">
          <p class="text-xs leading-relaxed text-nc-mut">
            Is video ka transcript abhi generate nahi hua.
            {#if isTauri()}
              Button dabao — tabhi API call hogi.{/if}
          </p>
          {#if project.loadError}
            <p class="mt-2 text-[11px] leading-relaxed text-nc-red">{project.loadError}</p>
          {/if}
          {#if isTauri()}
            <button
              onclick={() => void project.generateTranscript()}
              class="mt-3 rounded-lg bg-nc-brand px-3 py-1.5 text-[12.5px] font-semibold
                     text-white transition-[filter] duration-150 hover:brightness-110"
            >
              {project.loadError ? 'Dobara try karo' : 'Transcript generate karo'}
            </button>
            <p class="mt-2 text-[10.5px] text-nc-mut-2">
              Ek baar ban gaya to SQLite me save — dobara API nahi lagegi.
            </p>
          {:else}
            <p class="mt-2 text-[10.5px] text-nc-mut-2">Transcript ke liye desktop app use karo.</p>
          {/if}
        </div>
      {:else}
        <p class="p-6 text-center text-xs text-nc-mut">Is filter me koi line nahi hai.</p>
      {/if}
    {/if}
  </div>
</aside>
