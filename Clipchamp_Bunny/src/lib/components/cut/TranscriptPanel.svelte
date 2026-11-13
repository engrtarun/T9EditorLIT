<script lang="ts">
  import { project } from '../../stores/project.svelte';
  import { player } from '../../stores/player.svelte';
  import { layout } from '../../stores/layout.svelte';
  import { isTauri } from '../../ipc';
  import { estimateForDuration } from '../../transcript-plan';
  import { fmtShort } from '../../utils';
  import { LANGUAGES, isLanguageSwitch, languageLabel } from '../../languages';
  import { SENSITIVITIES, SENSITIVITY_LABEL, describeProfile } from '../../audio-profile';
  import type { Sensitivity } from '../../audio-profile';
  import type { LineFlag, TranscriptLine } from '../../types';
  import ProjectHealth from './ProjectHealth.svelte';
  import ShapeStrip from './ShapeStrip.svelte';

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

  /** "00:12–00:57, 03:20–03:45 +2 aur" — where the transcript has holes. */
  const missingLabel = $derived.by(() => {
    const spans = project.partialTranscript?.missing ?? [];
    if (!spans.length) return '';
    const shown = spans
      .slice(0, 3)
      .map((r) => `${fmtShort(r.startSec)}–${fmtShort(r.endSec)}`)
      .join(', ');
    return spans.length > 3 ? `${shown} +${spans.length - 3} aur` : shown;
  });

  /**
   * The cost card the playbook asks for (Case 2): duration is already probed,
   * and the splitter's default is 300 s, so the numbers are arithmetic — no
   * audio is touched and no API is called to show them.
   */
  const preClickEstimate = $derived(estimateForDuration(project.media?.durationSecs ?? 0));

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

  <!--
    The language chip, the override, and what the local measurement said
    about this recording.

    The detector guesses and the user knows: the chip shows what the daemon
    settled on, and the dropdown is the one click that says "no, it is
    English". A pinned language is never second-guessed by the daemon - it is
    only reported back when the text came back in a different script, which
    is the one case worth interrupting the user for.
  -->
  {#if !project.pipeline && (project.language || project.languageOverride || project.audioProfile)}
    <div
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-nc-line bg-nc-panel-2/60 px-2.5 py-1.5"
    >
      <label class="flex items-center gap-1.5 text-[10px] text-nc-mut">
        <span class="font-semibold tracking-wider text-nc-mut-2">LANG</span>
        <select
          value={project.languageOverride ?? ''}
          onchange={(e) => project.setLanguageOverride(e.currentTarget.value || null)}
          class="max-w-[140px] rounded border border-nc-line-2 bg-nc-panel px-1 py-0.5 text-[10.5px] text-nc-txt"
          title="Language pin — a pinned language is never second-guessed"
        >
          <option value="">
            Auto{project.language ? ` (${languageLabel(project.language)})` : ''}
          </option>
          {#each LANGUAGES as l (l.code)}
            <option value={l.code}>{l.label}</option>
          {/each}
        </select>
      </label>

      <label class="flex items-center gap-1.5 text-[10px] text-nc-mut">
        <span class="font-semibold tracking-wider text-nc-mut-2">SILENCE</span>
        <select
          value={project.sensitivity}
          onchange={(e) => project.setSensitivity(e.currentTarget.value as Sensitivity)}
          class="rounded border border-nc-line-2 bg-nc-panel px-1 py-0.5 text-[10.5px] text-nc-txt"
          title="Kitna zyada dead air cut ho — threshold is measured per file"
        >
          {#each SENSITIVITIES as s (s)}
            <option value={s}>{SENSITIVITY_LABEL[s]}</option>
          {/each}
        </select>
      </label>

      {#if project.audioProfile}
        <span
          class="font-mono text-[9.5px] text-nc-mut-2"
          title="Is file ka apna noise floor, voice level aur silence threshold"
        >
          {describeProfile(project.audioProfile)}
        </span>
      {/if}

      <div class="flex-1"></div>

      {#if project.lines.length && isTauri()}
        <button
          onclick={() => void project.translateTranscript('en')}
          class="rounded border border-nc-line-2 px-1.5 py-0.5 text-[10px] font-medium text-nc-mut
                 transition-colors hover:border-nc-brand hover:text-nc-brand"
          title="Source text ke neeche English translation — source text kabhi badalta nahi"
        >
          Translate
        </button>
      {/if}
    </div>
  {/if}

  {#if project.languageWarning}
    <div class="shrink-0 border-b border-amber-400/30 bg-amber-400/10 px-3 py-1.5">
      <p class="text-[10.5px] leading-snug text-amber-300">
        {project.languageWarning}
      </p>
    </div>
  {/if}

  <!--
    The import gate and the video's shape sit above the rows: they are facts
    about the whole file, not about one line. Both collapse, so a 46px row
    budget is not spent on badges the user has already read.
  -->
  <ProjectHealth />
  <ShapeStrip />

  <!--
    A transcript with holes must say so at the top of the panel, not only in
    the session that discovered them. The daemon deliberately keeps the chunks
    that worked (throwing away 48 good minutes over one bad chunk would be
    worse), but a silent gap in the text is indistinguishable from "nothing was
    said here" unless it is named.
  -->
  {#if project.partialTranscript && !project.pipeline}
    <div class="shrink-0 border-b border-amber-400/30 bg-amber-400/10 px-3 py-2">
      <p class="text-[11px] font-semibold leading-snug text-amber-300">
        Transcript adhoora hai — {project.partialTranscript.failedChunks.length} audio chunk padhe nahi
        ja sake
      </p>
      <p class="mt-0.5 text-[10px] leading-relaxed text-nc-mut">
        Missing: <span class="font-mono text-nc-txt">{missingLabel}</span>
      </p>
      <button
        onclick={() => void project.retryMissingTranscript()}
        class="mt-1.5 rounded border border-amber-400/50 bg-amber-400/10 px-2 py-1 text-[10.5px]
               font-semibold text-amber-200 transition-colors hover:bg-amber-400/20"
      >
        Adhoore hisse dobara try karo
      </button>
      <span class="ml-2 text-[9.5px] text-nc-mut-2">
        Sirf yeh chunks — baaki words dobara nahi bheje jaayenge.
      </span>
      {#if project.partialTranscript.error}
        <p class="mt-1 truncate text-[9.5px] text-nc-mut-2" title={project.partialTranscript.error}>
          {project.partialTranscript.error}
        </p>
      {/if}
    </div>
  {/if}

  <!--
    The bulk undo for the automatic silence pass. One mistaken cut is fixed by
    the per-line ✓ button; a whole pass the user disagrees with is not, and an
    auto-cut that cannot be taken back is not safe to offer.
  -->
  {#if !project.pipeline && project.aiCutCount > 0}
    <div
      class="flex shrink-0 items-center gap-2 border-b border-nc-line bg-nc-panel-2/80 px-3 py-1.5"
    >
      <span class="min-w-0 flex-1 text-[10.5px] leading-snug text-nc-mut">
        AI ne <span class="font-semibold text-nc-txt">{project.aiCutCount}</span> lines silence ki wajah
        se cut ki.
      </span>
      <button
        onclick={() => project.restoreAiCuts()}
        class="shrink-0 rounded border border-nc-green/50 px-2 py-0.5 text-[10px] font-semibold
               text-nc-green transition-colors hover:bg-nc-green/10"
      >
        Sab wapas lao
      </button>
    </div>
  {/if}

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
            <!--
              `dir="auto"` decides the reading direction from the text itself,
              so an Urdu or Arabic line reads right-to-left inside a
              left-to-right panel — and a mixed line does not flip the whole
              row. The font stack (app.css) carries the fallbacks, so
              Devanagari, Arabic and CJK never render as tofu boxes.
            -->
            <span
              class="line-clamp-2 text-xs leading-4 {cut
                ? 'nc-slash text-nc-mut line-through decoration-nc-red/70'
                : 'text-nc-txt'}"
              dir="auto"
            >
              {line.text}
            </span>
            {#if line.translatedText}
              <!--
                The translation is always secondary. The source text is what
                was said and what the cut decisions are made on; the
                translation is a second reading of the same line.
              -->
              <span
                class="mt-0.5 block truncate text-[10.5px] leading-4 italic text-nc-mut"
                dir="auto"
                title="Translation — source text neeche, original upar"
              >
                {line.translatedText}
              </span>
            {/if}
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
            <!--
              Cases 22-24 and 26, as one badge row: a non-speech tag becomes an
              icon, a collapsed loop shows how many copies it held, crosstalk
              and a retake ask for a decision instead of pretending to know.
            -->
            {#if line.tags?.length}
              <span
                class="mt-0.5 ml-1 inline-block rounded border border-nc-line-2 bg-nc-panel-2 px-1 py-[1px] text-[8px] text-nc-mut"
                dir="auto"
                title="Non-speech sound: {line.tags.join(', ')}"
              >
                {project.tagIcons(line)}
              </span>
            {/if}
            {#if line.repeatCount && line.repeatCount > 1}
              <span
                class="mt-0.5 ml-1 inline-block rounded border border-nc-line-2 bg-nc-panel-2 px-1 py-[1px] text-[8px] font-bold text-nc-mut"
                title="Whisper ne ye line {line.repeatCount} baar repeat ki — baaki copies collapsed hain"
              >
                ×{line.repeatCount}
              </span>
            {/if}
            {#if line.crosstalk}
              <span
                class="mt-0.5 ml-1 inline-block rounded border border-amber-400/40 bg-amber-400/10 px-1 py-[1px] text-[8px] font-bold tracking-wider text-amber-300"
                title="Do awaazein overlap kar rahi hain — auto-cut ise kabhi nahi chhuega"
              >
                2 VOICES
              </span>
            {/if}
            {#if line.needsConfirm}
              <!--
                The badge only asks. The answer lives in the right-hand
                action strip: a button nested inside the row's jump button is
                invalid markup, and a click would mean two things at once.
              -->
              <span
                class="mt-0.5 ml-1 inline-block rounded border border-amber-400/40 bg-amber-400/10 px-1 py-[1px] text-[8px] font-bold tracking-wider text-amber-300"
                title="Ye take ho sakta hai ki galti se bola gaya ho — right side se decide karo"
              >
                {line.repeatKind === 'stutter' ? 'STUTTER?' : 'RETAKE?'}
              </span>
            {/if}
            {#if isLanguageSwitch(line.language, project.language)}
              <!--
                The badge appears only on the odd line out: a chip on every
                line of a Hindi video is noise, a chip on the one English
                line is information.
              -->
              <span
                class="mt-0.5 ml-1 inline-block rounded border border-nc-line-2 bg-nc-panel-2 px-1
                       py-[1px] text-[8px] font-bold tracking-wider text-nc-mut"
                title="Ye line is language me hai jo baaki transcript se alag hai"
              >
                {languageLabel(line.language)}
              </span>
            {/if}
          </span>
        </button>

        <div class="flex shrink-0 items-center gap-1">
          {#if line.needsConfirm}
            <!-- The user's answer to a retake suggestion (case 26). -->
            <button
              onclick={() => project.resolveLine(line.id, 'cut')}
              class="rounded border border-nc-red/40 px-1 py-[1px] text-[8px] font-bold text-nc-red hover:bg-nc-red/10"
              title="Pehla take cut karo"
            >
              cut
            </button>
            <button
              onclick={() => project.resolveLine(line.id, 'keep')}
              class="rounded border border-nc-green/40 px-1 py-[1px] text-[8px] font-bold text-nc-green hover:bg-nc-green/10"
              title="Rakho — ye take sahi hai"
            >
              keep
            </button>
          {/if}
          <!--
            The escape hatch for every detector that cannot be trusted: a
            whisper, a crosstalk overlap, a hook that reads as silence. The
            automatic silence pass skips a pinned line; the user can still cut
            it by hand.
          -->
          <button
            onclick={() => project.toggleProtected(line.id)}
            class="grid h-6 w-6 place-items-center rounded border transition-colors
                   {line.protected
              ? 'border-nc-brand bg-nc-brand/15 text-nc-brand'
              : 'border-nc-line-2 text-nc-mut-2 hover:border-nc-brand hover:text-nc-brand'}"
            title="Is line ko kabhi auto-cut mat karo"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
            >
              <path d="M12 17v5M9 3h6l-1 6 3 3H7l3-3-1-6z" />
            </svg>
          </button>
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
          never asked the cloud for a transcript — or it asked, and the honest
          answer was "no speech here".
        -->
        {#if project.noSpeech}
          <!--
            The daemon read every chunk and heard no words: the audio is music,
            ambience or a silent recording. A result, not an error — amber,
            calm, and with the one honest way forward.

            "Music" is its own answer, though, and it gets its own card: for a
            music track the waveform *is* the tool, so the panel says what to
            do instead of offering a retry that can never find words.
          -->
          <div class="p-6 text-center">
            <div
              class="mx-auto w-fit rounded-lg border border-amber-400/40 bg-amber-400/10 px-3
                     py-1.5 text-[11.5px] font-semibold text-amber-300"
            >
              {#if project.music}🎵 Ye ek music project hai{:else}🎵 Koi speech nahi mili{/if}
            </div>
            <p class="mt-3 text-[11.5px] leading-relaxed text-nc-mut">
              {#if project.music}
                Is audio me bolne wala koi nahi hai — sirf music/ambience. Transcript isliye nahi
                bana, aur banane ka koi faayda bhi nahi.
              {:else}
                Is audio me sirf music/ambience hai — Whisper ne koi words nahi suna, isliye
                transcript nahi bana. Fake "Thank you." jaisi lines ab drop ho jaati hain.
              {/if}
            </p>
            {#if project.audioProfile}
              <p class="mt-2 font-mono text-[10px] text-nc-mut-2">
                {describeProfile(project.audioProfile)}
              </p>
            {/if}
            <p class="mt-2 text-[10.5px] text-nc-mut-2">
              Silence scanning aur cut tools bina transcript ke bhi kaam karte hain — waveform
              timeline se kaam chal jayega.
            </p>
            {#if isTauri()}
              <button
                onclick={() => void project.generateTranscript()}
                disabled={project.planRunning}
                class="mt-3 rounded-lg bg-nc-brand px-3 py-1.5 text-[12.5px] font-semibold
                       text-white transition-[filter] duration-150 hover:brightness-110
                       disabled:cursor-progress disabled:opacity-70"
              >
                {#if project.planRunning}
                  … shuru ho raha hai
                {:else}
                  Phir bhi try karo
                {/if}
              </button>
            {/if}
          </div>
        {:else}
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
                disabled={project.planRunning}
                class="mt-3 rounded-lg bg-nc-brand px-3 py-1.5 text-[12.5px] font-semibold
                       text-white transition-[filter] duration-150 hover:brightness-110
                       disabled:cursor-progress disabled:opacity-70"
              >
                {#if project.planRunning}
                  … shuru ho raha hai
                {:else}
                  {project.loadError ? 'Dobara try karo' : 'Transcript generate karo'}
                {/if}
              </button>
              {#if preClickEstimate.calls}
                <p class="mt-2 font-mono text-[10px] leading-relaxed text-nc-mut">
                  ~{fmtShort(preClickEstimate.audioSecs)} audio · {preClickEstimate.calls} Whisper calls
                  · ~{fmtShort(preClickEstimate.etaSecs)} wait (estimate)
                </p>
              {/if}
              <p class="mt-1 text-[10.5px] text-nc-mut-2">
                Pehla chunk turant banega — poora video ek saath nahi. Har chunk SQLite me save hota
                hai.
              </p>
            {:else}
              <p class="mt-2 text-[10.5px] text-nc-mut-2">
                Transcript ke liye desktop app use karo.
              </p>
            {/if}
          </div>
        {/if}
      {:else}
        <p class="p-6 text-center text-xs text-nc-mut">Is filter me koi line nahi hai.</p>
      {/if}
    {/if}
  </div>

  <!--
    Incremental transcript footer.

    The first click buys one chunk; this bar is where the rest is decided.
    "Agla chunk" is one more call, "Sab banao" walks the pending ones, "Rok do"
    stops after the chunk already in flight. The plan (and every finished
    chunk's words) is in SQLite, so closing the app does not lose the money
    already spent — reopening resumes at this exact count.
  -->
  {#if project.transcriptPlan}
    <div class="shrink-0 border-t border-nc-line bg-nc-panel-2/80 px-3 py-2">
      <div class="flex items-center justify-between gap-2">
        <span class="font-mono text-[10px] text-nc-mut">
          Transcript <span class="font-semibold text-nc-txt"
            >{project.planDone}/{project.planTotal}</span
          > chunks
        </span>
        {#if project.planRunning}
          <button
            onclick={() => project.stopTranscript()}
            class="shrink-0 rounded border border-nc-red/40 bg-nc-red/10 px-2 py-0.5 text-[10px]
                   font-semibold text-nc-red transition-colors hover:bg-nc-red/20"
          >
            Rok do
          </button>
        {:else if !project.planComplete}
          <span class="font-mono text-[9.5px] text-nc-mut-2">
            {fmtShort(project.planEstimate.audioSecs)} · {project.planEstimate.calls} calls
          </span>
        {/if}
      </div>

      {#if project.planRunning}
        <div class="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-nc-panel">
          <div
            class="h-full rounded-full bg-nc-brand transition-[width] duration-300"
            style="width:{Math.max(3, Math.round((project.pipeline?.fraction ?? 0.05) * 100))}%"
          ></div>
        </div>
        <p class="mt-1 truncate text-[10px] text-nc-mut-2">
          {project.pipeline?.stage ?? 'Chunk chal raha hai…'}
        </p>
      {:else if project.planComplete}
        <div class="mt-1.5 flex items-center gap-2">
          <p class="min-w-0 flex-1 text-[10px] leading-snug text-nc-mut">
            Saare chunks SQLite me hain — spelling autocorrect aur AI flags baaki hain.
          </p>
          <button
            onclick={() => void project.transcribeAllChunks()}
            class="shrink-0 rounded bg-nc-brand px-2 py-1 text-[10.5px] font-semibold text-white
                   transition-[filter] duration-150 hover:brightness-110"
          >
            Finish karo
          </button>
        </div>
      {:else}
        <!--
          Case 10: a plan that stopped because the network/daemon went away
          says so, with evidence — the failure text must actually look like a
          connection problem. "Offline" here means "nothing is lost, the
          remaining chunks are still pending", not an error.
        -->
        {#if project.transcriptOffline}
          <div
            class="mt-1 flex items-start gap-1.5 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1"
          >
            <span class="shrink-0 text-[10px] font-semibold text-amber-300">Offline</span>
            <span class="min-w-0 text-[9.5px] leading-snug text-nc-mut">
              {project.planPending} chunk pending — network/daemon wapas aane par "Agla chunk" dabao.
              Kuch bhi delete nahi hua; har done chunk SQLite me hai.
            </span>
          </div>
        {:else if project.planFailed.length}
          <p class="mt-1 text-[9.5px] leading-snug text-nc-red">
            {project.planFailed.length} chunk fail hue — "Agla chunk" unhe dobara try karega.
          </p>
        {/if}
        <p class="mt-0.5 text-[9.5px] leading-snug text-nc-mut-2">
          {#if project.nextPlanSpan}
            Agla chunk {fmtShort(project.nextPlanSpan.startSec)}–{fmtShort(
              project.nextPlanSpan.endSec
            )} ({fmtShort(project.nextPlanSpan.endSec - project.nextPlanSpan.startSec)} audio) ·
          {/if}
          har chunk turant SQLite me save hota hai.
        </p>
        <div class="mt-1.5 flex items-center gap-2">
          <button
            onclick={() => void project.nextTranscriptChunk()}
            class="rounded bg-nc-brand px-2 py-1 text-[10.5px] font-semibold text-white
                   transition-[filter] duration-150 hover:brightness-110"
          >
            Agla chunk banao
          </button>
          {#if project.planEstimate.calls > 1}
            <button
              onclick={() => void project.transcribeAllChunks()}
              class="rounded border border-nc-brand/50 px-2 py-1 text-[10.5px] font-semibold
                     text-nc-brand transition-colors hover:bg-nc-brand/10"
            >
              Sab banao ({project.planEstimate.calls})
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</aside>
