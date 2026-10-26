<script lang="ts">
  import { mode } from '../../stores/mode.svelte';
  import { project } from '../../stores/project.svelte';
  import { media } from '../../stores/media.svelte';
  import { cloud } from '../../stores/cloud.svelte';
  import MediaPanel from '../media/MediaPanel.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { isTauri, demoSourcePath } from '../../ipc';
  import { fmtShort } from '../../utils';
  import type { SilenceRange } from '../../types';

  /**
   * MODE 1 — MEDIA.
   *
   * The app exists for two things: strip the dead air, and cut by reading the
   * transcript. Both start here: import a file, let the engine find the
   * silences, then read what is left in the Cut mode.
   */
  type Step = { label: string; detail: string; ms: number };
  const STEPS: Step[] = [
    { label: 'FFmpeg · audio extract', detail: '-vn -ac 1 -ar 16k · 5GB in, ~20MB out', ms: 900 },
    {
      label: 'Chunk & upload',
      detail: '1.9 GB split · Groq Whisper Large v3',
      ms: 1200
    },
    { label: 'Whisper · transcript', detail: 'word + segment timestamps', ms: 1400 },
    {
      label: 'Gemini · fumble brain',
      detail: 'repeat / galat-example / silence detect',
      ms: 1100
    },
    { label: 'SQLite · persist', detail: 'transcripts table · disk, not heap', ms: 500 }
  ];

  let running = $state(false);
  let stepIndex = $state(-1);
  let progress = $state(0);
  let dragging = $state(false);

  /* ---- dead air ---- */
  let minSecs = $state(3.0);
  let scanning = $state(false);
  let silences = $state<SilenceRange[]>([]);
  let scanned = $state(false);

  const deadSecs = $derived(silences.reduce((t, r) => t + (r.end - r.start), 0));

  function cleanup() {
    timers.forEach(clearTimeout);
    timers = [];
  }
  let timers: ReturnType<typeof setTimeout>[] = [];
  $effect(() => cleanup);

  function run() {
    if (running) return;
    running = true;
    stepIndex = -1;
    progress = 0;

    let elapsed = 0;
    const total = STEPS.reduce((a, s) => a + s.ms, 0);
    STEPS.forEach((s, i) => {
      elapsed += s.ms;
      timers.push(
        setTimeout(() => {
          stepIndex = i;
          progress = (elapsed / total) * 100;
        }, elapsed - s.ms)
      );
    });
    timers.push(
      setTimeout(() => {
        progress = 100;
        stepIndex = STEPS.length;
        running = false;
      }, total + 200)
    );
  }

  /**
   * The "keep going without a file" button.
   *
   * On the desktop this opens the **real** demo recording from disk — the
   * same file the app opens on its very first run, with a real transcript.
   * Only the browser build (no filesystem, no engine) falls back to the
   * animated walkthrough.
   */
  async function openDemo() {
    if (!isTauri()) {
      run();
      return;
    }
    try {
      const path = await demoSourcePath();
      if (!path) {
        toast.push('warn', 'Demo recording nahi mili — apni video import karo');
        return;
      }
      await project.loadFromBackend(path);
      mode.set('cut');
    } catch (e) {
      toast.push('warn', `Demo nahi khul paaya: ${e instanceof Error ? e.message : e}`);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    for (const f of [...files]) {
      if (f.type.startsWith('video/') || f.type.startsWith('audio/')) {
        media.add(f, URL.createObjectURL(f));
      }
    }
    run();
  }

  async function findSilences() {
    if (scanning) return;
    scanning = true;
    silences = [];
    scanned = false;
    toast.push('info', `Scanning for pauses ≥ ${minSecs.toFixed(1)}s…`);
    try {
      const found = await project.findSilences(minSecs);
      silences = found;
      scanned = true;
      toast.push(
        found.length ? 'info' : 'warn',
        found.length
          ? `${found.length} silences · ${deadSecs.toFixed(1)}s dead air`
          : 'Koi long pause nahi mili'
      );
    } catch (e) {
      toast.push('warn', `Scan failed: ${e instanceof Error ? e.message : e}`);
    }
    scanning = false;
  }

  function cutAll() {
    const n = project.cutSilences(silences);
    toast.push('cut', `✕ ${n} lines cut — ${deadSecs.toFixed(1)}s dead air hata diya`);
  }
</script>

<!-- MODE 1 — MEDIA · left = "My media", right = the dead-air workbench -->
<div class="flex min-h-0 flex-1">
  <MediaPanel />

  <div class="flex min-w-0 flex-1 flex-col">
    <div class="flex h-10 shrink-0 items-center gap-2 border-b border-nc-line bg-nc-panel px-3">
      <h2 class="text-[13px] font-semibold">Media · Dead air</h2>
      <span class="rounded bg-nc-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-nc-mut">
        {media.entries.length} asset{media.entries.length === 1 ? '' : 's'}
      </span>
      <div class="flex-1"></div>
      <span class="flex items-center gap-1.5 text-[10px] text-nc-mut">
        <i
          class="h-1.5 w-1.5 rounded-full {cloud.get('groq')?.status === 'connected'
            ? 'bg-nc-green'
            : 'bg-nc-mut-2'}"
        ></i>
        Groq
        <i
          class="ml-2 h-1.5 w-1.5 rounded-full {cloud.get('gemini')?.status === 'connected'
            ? 'bg-nc-green'
            : 'bg-nc-mut-2'}"
        ></i>
        Gemini
      </span>
    </div>

    <div class="nc-scroll min-h-0 flex-1 p-6">
      <div class="mx-auto flex max-w-3xl flex-col gap-5">
        <!-- drop zone -->
        <div
          ondragover={(e) => {
            e.preventDefault();
            dragging = true;
          }}
          ondragleave={() => (dragging = false)}
          ondrop={onDrop}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              run();
            }
          }}
          role="button"
          tabindex="0"
          aria-label="Drop a video file here, or press Enter to continue"
          class="nc-tie-edge flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-8 py-7 text-center transition-colors
                 {dragging ? 'border-nc-brand bg-nc-brand/5' : 'border-nc-line-2 bg-nc-panel'}"
        >
          <svg
            width="34"
            height="34"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            class="text-nc-brand"
          >
            <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
          </svg>
          <p class="text-sm font-bold">Video yahan drop karo</p>
          <p class="max-w-md text-[11px] leading-relaxed text-nc-mut">
            5 GB · 2 ghante · 4K 60FPS chalega. Video kabhi RAM me nahi jayegi.
          </p>
          <button
            onclick={openDemo}
            class="text-[11px] text-nc-mut underline underline-offset-2 hover:text-nc-brand"
          >
            …ya demo recording kholo
          </button>
        </div>

        <!-- DEAD AIR workbench -->
        <section class="rounded-xl border border-nc-line bg-nc-panel p-4">
          <div class="mb-3 flex items-center gap-2">
            <h3 class="text-[10px] font-bold tracking-widest text-nc-brand">DEAD AIR</h3>
            <span class="text-[10px] text-nc-mut-2"> FFmpeg silencedetect · −30 dB RMS </span>
            <div class="flex-1"></div>
            {#if scanned}
              <span class="font-mono text-[11px] text-nc-mut">
                {silences.length} silences · <span class="text-nc-red">{deadSecs.toFixed(1)}s</span> dead
              </span>
            {/if}
          </div>

          <div class="flex items-center gap-3">
            <label for="silence-threshold" class="text-[11px] text-nc-mut">Pause ≥</label>
            <input
              id="silence-threshold"
              type="range"
              min="0.5"
              max="10"
              step="0.5"
              bind:value={minSecs}
              class="flex-1 accent-nc-brand"
            />
            <span class="w-10 text-right font-mono text-[12px] text-nc-txt"
              >{minSecs.toFixed(1)}s</span
            >
          </div>
          <p class="mt-1 text-[10px] text-nc-mut-2">
            AI auto-cut 3 second se lambi khamoshi hatata hai — wahi default.
          </p>

          <div class="mt-3 flex gap-2">
            <button
              onclick={findSilences}
              disabled={scanning || !isTauri()}
              class="flex-1 rounded-lg border border-nc-line bg-nc-panel-2 py-2 text-xs font-medium hover:border-nc-brand/50 disabled:opacity-40"
              title={isTauri() ? '' : 'Desktop app me chalta hai (FFmpeg engine)'}
            >
              {scanning ? 'Scanning…' : 'Find silences'}
            </button>
            <button
              onclick={cutAll}
              disabled={!silences.length}
              class="flex-1 rounded-lg bg-nc-red/45 py-2 text-xs font-bold text-white backdrop-blur-md hover:bg-nc-red/65 disabled:opacity-40"
            >
              ✕ Cut all ({silences.length})
            </button>
          </div>

          {#if silences.length}
            <ul class="mt-3 max-h-40 space-y-1 overflow-auto">
              {#each silences as r, i (i)}
                <li
                  class="flex items-center gap-2 rounded border border-nc-line bg-nc-panel-2 px-2 py-1 font-mono text-[10px]"
                >
                  <span class="text-nc-txt">{fmtShort(r.start)}</span>
                  <span class="text-nc-mut-2">→</span>
                  <span class="text-nc-txt">{fmtShort(r.end)}</span>
                  <span class="ml-auto text-nc-red">{(r.end - r.start).toFixed(1)}s</span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- pipeline -->
        <section class="rounded-xl border border-nc-line bg-nc-panel p-4">
          <div class="mb-3 flex items-center gap-2">
            <h3 class="text-[10px] font-bold tracking-widest text-nc-mut">TRANSCRIPT PIPELINE</h3>
            <div class="flex-1"></div>
            {#if isTauri()}
              <span class="font-mono text-[11px] text-nc-brand">
                {project.pipeline ? (project.pipeline.fraction * 100).toFixed(0) : '0'}%
              </span>
            {:else}
              <span class="font-mono text-[11px] text-nc-brand">{progress.toFixed(0)}%</span>
            {/if}
          </div>

          <!-- the real cloud pipeline, running once per imported source -->
          {#if project.pipeline}
            <div class="mb-4 rounded-lg border border-nc-brand/40 bg-nc-brand/5 p-3">
              <div class="mb-1.5 flex items-center gap-2 text-[11px]">
                <span class="text-nc-brand">{project.pipeline.stage}</span>
                <span class="ml-auto font-mono text-nc-mut">
                  {(project.pipeline.fraction * 100).toFixed(0)}%
                </span>
              </div>
              <div class="h-1.5 overflow-hidden rounded-full bg-nc-panel-2">
                <div
                  class="h-full rounded-full bg-gradient-to-r from-nc-brand to-nc-green transition-[width] duration-300"
                  style="width:{project.pipeline.fraction * 100}%"
                ></div>
              </div>
              <p class="mt-1.5 text-[9px] text-nc-mut-2">
                Ye sirf ek baar chalta hai — result SQLite me save hota hai, phir sirf disk se padha
                jayega.
              </p>
            </div>
          {/if}

          <!--
            The walkthrough below is the **browser** stand-in: there is no
            engine in the browser, so it shows what the real pipeline would
            do. On the desktop only the real progress above is shown, because
            a fake percentage is worse than no percentage.
          -->
          {#if !isTauri()}
            <div class="mb-4 h-1.5 overflow-hidden rounded-full bg-nc-panel-2">
              <div
                class="h-full rounded-full bg-gradient-to-r from-nc-brand to-nc-brand-dim transition-[width] duration-200"
                style="width:{progress}%"
              ></div>
            </div>
            <ol class="space-y-2">
              {#each STEPS as s, i (s.label)}
                {@const state = i < stepIndex ? 'done' : i === stepIndex ? 'active' : 'idle'}
                <li class="flex items-center gap-3 text-xs">
                  <span
                    class="grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px]
                           {state === 'done'
                      ? 'border-nc-green bg-nc-green/15 text-nc-green'
                      : state === 'active'
                        ? 'border-nc-brand bg-nc-brand/15 text-nc-brand'
                        : 'border-nc-line-2 text-nc-mut-2'}"
                  >
                    {state === 'done' ? '✓' : i + 1}
                  </span>
                  <span class={state === 'idle' ? 'text-nc-mut-2' : 'text-nc-txt'}>{s.label}</span>
                  <span class="ml-auto font-mono text-[10px] text-nc-mut-2">{s.detail}</span>
                </li>
              {/each}
            </ol>
          {/if}

          <button
            onclick={() => mode.set('cut')}
            class="mt-4 w-full rounded-lg bg-nc-brand py-2.5 text-sm font-bold text-nc-bg hover:brightness-110"
          >
            Transcript padho aur cut karo →
          </button>
        </section>
      </div>
    </div>
  </div>
</div>
