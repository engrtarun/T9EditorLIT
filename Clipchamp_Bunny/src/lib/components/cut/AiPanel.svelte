<script lang="ts">
  /**
   * THE AI PANEL — Gemini, under the user's hand.
   *
   * Transcription used to run `/v1/analyze` on its own after every import.
   * That spent a Gemini call whether or not anyone wanted the flags, and it
   * made the AI feel like something that happened *to* the project. This panel
   * is the whole contract instead:
   *
   *   · **Analyse** is the only way the pass runs — nothing starts by itself,
   *   · the key can be added, replaced or removed here (loopback daemon only),
   *   · usage is shown before you spend more of it,
   *   · the marks are a display switch: hiding them keeps the data.
   *
   * It renders as a drawer anchored to the right rail so the transcript stays
   * visible underneath — the flags it produces are in there.
   */
  import { project } from '../../stores/project.svelte';
  import { settings } from '../../stores/settings.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { usageStore } from '../../usage-store.svelte';
  import { probeGemini, saveApiKey, deleteApiKey } from '../../cloud';

  let { onClose }: { onClose: () => void } = $props();

  /** The typed key lives here and nowhere else; saving hands it to the daemon. */
  let key = $state('');
  let reveal = $state(false);
  let keyBusy = $state(false);
  let checking = $state(false);
  let running = $state(false);
  let keyNote = $state<{ ok: boolean; text: string } | null>(null);

  // Poll usage only while the panel is on screen (the store is refcounted).
  $effect(() => usageStore.attach());

  const geminiKey = $derived(usageStore.keys.find((k) => k.service === 'gemini') ?? null);
  const usage = $derived(usageStore.gemini);
  const configured = $derived(geminiKey?.configured === true);
  const busy = $derived(running || !!project.pipeline);

  /** Re-verify the key the daemon was started with — costs no quota. */
  async function recheck(): Promise<void> {
    if (checking) return;
    checking = true;
    keyNote = null;
    try {
      const res = await probeGemini('');
      keyNote = res.ok
        ? {
            ok: true,
            text: `Key is live${res.detail && res.detail !== 'ok' ? ` · ${res.detail}` : ''}`
          }
        : {
            ok: false,
            text:
              res.detail === 'unavailable'
                ? 'Daemon is not reachable, so the key cannot be tested.'
                : `Key rejected · ${res.detail}`
          };
    } finally {
      checking = false;
    }
  }

  /** Save + hot-swap: the next analysis uses this key without a restart. */
  async function saveKey(): Promise<void> {
    const typed = key.trim();
    if (!typed) {
      keyNote = { ok: false, text: 'Paste a Gemini API key first.' };
      return;
    }
    if (keyBusy) return;
    keyBusy = true;
    keyNote = null;
    try {
      const res = await saveApiKey('gemini', typed);
      if (res.ok) {
        key = '';
        keyNote = { ok: true, text: `Saved · ${res.detail}` };
        toast.push('info', 'Gemini key saved — analysis will use it now');
        await usageStore.refresh();
      } else {
        keyNote = {
          ok: false,
          text:
            res.detail === 'unavailable'
              ? 'The T9 Cloud daemon is not running, so the key could not be saved.'
              : `Not saved · ${res.detail}`
        };
      }
    } finally {
      keyBusy = false;
    }
  }

  async function removeKey(): Promise<void> {
    if (keyBusy) return;
    keyBusy = true;
    keyNote = null;
    try {
      const res = await deleteApiKey('gemini');
      keyNote = res.ok
        ? { ok: true, text: 'Key removed. Analysis is off until a new key is added.' }
        : { ok: false, text: `Could not remove · ${res.detail}` };
      await usageStore.refresh();
    } finally {
      keyBusy = false;
    }
  }

  /** The one and only trigger for /v1/analyze. */
  async function analyse(): Promise<void> {
    if (busy) return;
    running = true;
    try {
      const res = await project.runAiAnalysis();
      if (res.ok) {
        toast.push(
          'info',
          res.flagged
            ? `Gemini flagged ${res.flagged} line${res.flagged === 1 ? '' : 's'}`
            : 'Gemini found nothing to flag'
        );
        if (!res.flagged) settings.setAiMarksVisible(true);
      } else {
        toast.push('warn', `Gemini analysis failed — ${res.error}`);
      }
    } finally {
      running = false;
    }
  }

  const pct = (n: number): string => (n < 0 ? '—' : `${Math.round(n)}%`);
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') onClose();
  }}
/>

<!-- backdrop: the editor stays visible, the click closes -->
<div
  class="fixed inset-0 z-[70] bg-black/40"
  role="presentation"
  onclick={onClose}
  onkeydown={(e) => {
    if (e.key === 'Escape') onClose();
  }}
></div>

<div
  class="t9-panel-in fixed top-14 right-[60px] bottom-24 z-[71] flex w-[360px] flex-col overflow-hidden
         rounded-xl border border-nc-line bg-nc-panel shadow-2xl"
  role="dialog"
  aria-label="AI analysis"
>
  <!-- header -->
  <header class="flex items-center gap-2 border-b border-nc-line px-4 py-3">
    <span
      class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-nc-line bg-nc-panel-2"
      aria-hidden="true"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" class="text-nc-brand">
        <path
          d="M12 2c.4 4.6 3.4 7.6 8 8-4.6.4-7.6 3.4-8 8-.4-4.6-3.4-7.6-8-8 4.6-.4 7.6-3.4 8-8Z"
          fill="currentColor"
        />
      </svg>
    </span>
    <div class="min-w-0 flex-1">
      <h2 class="text-[13px] font-semibold text-nc-txt">Gemini analysis</h2>
      <p class="text-[10.5px] text-nc-mut-2">Runs only when you press Analyse</p>
    </div>
    <span
      class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium
             {configured ? 'bg-nc-green/15 text-nc-green' : 'bg-nc-mut/10 text-nc-mut'}"
    >
      {configured ? 'Key ready' : 'No key'}
    </span>
    <button
      onclick={onClose}
      aria-label="Close AI panel"
      class="ml-1 grid h-7 w-7 place-items-center rounded-md text-nc-mut transition-colors
             hover:bg-nc-panel-2 hover:text-nc-txt"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  </header>

  <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
    <!-- what it does -->
    <section class="rounded-lg border border-nc-line bg-nc-bg/40 p-3">
      <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">WHAT IT DOES</h3>
      <p class="mt-1.5 text-[11.5px] leading-relaxed text-nc-mut">
        Gemini reads the finished transcript and marks lines that look like a fumble, a repeated
        take, or a wrong example — the things a listener would want removed. It never cuts by
        itself: the marks are hints on the transcript, and you decide what to do with them.
      </p>
      <p class="mt-1.5 text-[10.5px] leading-relaxed text-nc-mut-2">
        One pass per press. The transcript is already saved, so a failure costs the flags and
        nothing else.
      </p>
    </section>

    <!-- run -->
    <section class="rounded-lg border border-nc-line bg-nc-bg/40 p-3">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">ANALYSE</h3>
        <span class="text-[10.5px] text-nc-mut-2">
          {project.aiFlagCount > 0
            ? `${project.aiFlagCount} flagged line${project.aiFlagCount === 1 ? '' : 's'}`
            : 'no flags yet'}
        </span>
      </div>

      {#if project.pipeline}
        <p class="mt-2 flex items-center gap-2 text-[11.5px] text-nc-mut">
          <span
            class="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-nc-brand/30 border-t-nc-brand"
            aria-hidden="true"
          ></span>
          {project.pipeline.stage}
          {#if project.pipeline.total}
            · {project.pipeline.completed ?? 0}/{project.pipeline.total}
          {/if}
        </p>
      {:else if running}
        <p class="mt-2 flex items-center gap-2 text-[11.5px] text-nc-mut">
          <span
            class="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-nc-brand/30 border-t-nc-brand"
            aria-hidden="true"
          ></span>
          Starting…
        </p>
      {:else}
        <p class="mt-1.5 text-[11.5px] leading-relaxed text-nc-mut">
          {#if !project.lines.length}
            There is no transcript yet. Transcribe or import one first.
          {:else if !configured}
            Add a Gemini key below, then run the pass.
          {:else}
            The transcript has {project.lines.length} lines. Run the pass when you want the marks.
          {/if}
        </p>
      {/if}

      <button
        type="button"
        onclick={() => void analyse()}
        disabled={busy || !project.lines.length}
        class="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border
               border-nc-brand/50 bg-nc-brand/10 px-3 py-2 text-[12.5px] font-medium text-nc-brand
               transition-colors duration-150 hover:bg-nc-brand/20 disabled:opacity-50"
      >
        {#if busy}Analysing…{:else if project.aiFlagCount > 0}Analyse again{:else}Analyse transcript{/if}
      </button>
    </section>

    <!-- marks -->
    <section class="rounded-lg border border-nc-line bg-nc-bg/40 p-3">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-[12px] font-medium text-nc-txt">Show Gemini marks</p>
          <p class="mt-0.5 text-[10.5px] leading-snug text-nc-mut-2">
            Hides the fumble/repeat chips and empties the “AI Flagged” filter. The flags stay saved,
            so turning this back on costs no API call.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.aiMarksVisible}
          aria-label="Show Gemini marks"
          onclick={() => settings.setAiMarksVisible(!settings.aiMarksVisible)}
          class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border
                 transition-colors duration-150
                 {settings.aiMarksVisible
            ? 'border-nc-brand/50 bg-nc-brand/30'
            : 'border-nc-line bg-nc-panel-2'}"
        >
          <span
            class="inline-block h-4 w-4 transform rounded-full bg-nc-txt shadow transition-transform duration-150
                   {settings.aiMarksVisible ? 'translate-x-6' : 'translate-x-1'}"
          ></span>
        </button>
      </div>
    </section>

    <!-- usage -->
    <section class="rounded-lg border border-nc-line bg-nc-bg/40 p-3">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">USAGE</h3>
        <button
          onclick={() => void usageStore.refresh()}
          class="text-[10.5px] text-nc-mut-2 underline decoration-dotted underline-offset-2 hover:text-nc-txt"
        >
          Refresh
        </button>
      </div>
      {#if usageStore.link === 'down'}
        <p class="mt-1.5 text-[11px] text-nc-mut-2">
          T9 Cloud daemon is not reachable, so there is no usage to show.
        </p>
      {:else if usageStore.link === 'outdated'}
        <p class="mt-1.5 text-[11px] text-nc-mut-2">
          This daemon build has no usage endpoint yet — update T9 Cloud to see the counters.
        </p>
      {:else if usage}
        <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
          <dt class="text-nc-mut-2">Calls</dt>
          <dd class="text-right font-mono text-nc-txt tabular-nums">{usage.calls}</dd>
          <dt class="text-nc-mut-2">Tokens in / out</dt>
          <dd class="text-right font-mono text-nc-txt tabular-nums">
            {usage.tokensIn.toLocaleString()} / {usage.tokensOut.toLocaleString()}
          </dd>
          <dt class="text-nc-mut-2">Errors</dt>
          <dd class="text-right font-mono text-nc-txt tabular-nums">{usage.errors}</dd>
          <dt class="text-nc-mut-2">Daily limit used</dt>
          <dd class="text-right font-mono text-nc-txt tabular-nums">
            {pct(usage.requestsUsedPct)}
          </dd>
        </dl>
        {#if usage.lastCall}
          <p class="mt-1.5 text-[10px] text-nc-mut-2">Last call {usage.lastCall}</p>
        {/if}
      {:else}
        <p class="mt-1.5 text-[11px] text-nc-mut-2">Loading usage…</p>
      {/if}
    </section>

    <!-- key -->
    <section class="rounded-lg border border-nc-line bg-nc-bg/40 p-3">
      <div class="flex items-baseline justify-between gap-2">
        <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">GEMINI KEY</h3>
        {#if configured}
          <span class="font-mono text-[10px] text-nc-mut-2"
            >{geminiKey?.masked ?? 'configured'}</span
          >
        {/if}
      </div>
      <p class="mt-1.5 text-[10.5px] leading-relaxed text-nc-mut-2">
        Stored by the T9 Cloud daemon on this machine and used immediately — no restart. You can
        replace it here at any time.
      </p>

      <div class="mt-2 flex gap-2">
        <div class="relative min-w-0 flex-1">
          <input
            type={reveal ? 'text' : 'password'}
            bind:value={key}
            placeholder={configured ? 'Replace key…' : 'Paste API key…'}
            autocomplete="off"
            spellcheck="false"
            aria-label="Gemini API key"
            class="w-full rounded-lg border border-nc-line bg-nc-bg/70 py-1.5 pr-8 pl-2.5 text-[12px]
                   text-nc-txt placeholder:text-nc-mut-2 focus:border-nc-brand/60 focus:outline-none"
          />
          <button
            type="button"
            onclick={() => (reveal = !reveal)}
            aria-label={reveal ? 'Hide key' : 'Show key'}
            class="absolute inset-y-0 right-0 grid w-8 place-items-center text-nc-mut-2 hover:text-nc-txt"
          >
            {reveal ? '–' : '👁'}
          </button>
        </div>
        <button
          type="button"
          onclick={() => void saveKey()}
          disabled={keyBusy}
          class="shrink-0 rounded-lg border border-nc-brand/50 bg-nc-brand/10 px-2.5 py-1.5 text-[11.5px]
                 font-medium text-nc-brand transition-colors hover:bg-nc-brand/20 disabled:opacity-50"
        >
          {configured ? 'Replace' : 'Save'}
        </button>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-2">
        <button
          onclick={() => void recheck()}
          disabled={checking}
          class="rounded-md border border-nc-line px-2 py-1 text-[10.5px] text-nc-mut
                 transition-colors hover:border-nc-line-2 hover:text-nc-txt disabled:opacity-50"
        >
          {checking ? 'Testing…' : 'Test key'}
        </button>
        {#if configured}
          <button
            onclick={() => void removeKey()}
            disabled={keyBusy}
            class="rounded-md px-2 py-1 text-[10.5px] text-nc-red/80 underline decoration-dotted
                   underline-offset-2 transition-colors hover:text-nc-red disabled:opacity-50"
          >
            Remove
          </button>
        {/if}
      </div>

      {#if keyNote}
        <p
          role="status"
          class="mt-2 text-[11px] leading-snug {keyNote.ok ? 'text-nc-green' : 'text-nc-red'}"
        >
          {keyNote.text}
        </p>
      {/if}
    </section>
  </div>
</div>
