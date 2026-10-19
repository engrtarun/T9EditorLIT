<script lang="ts">
  import { mode } from '../../stores/mode.svelte';
  import { project } from '../../stores/project.svelte';
  import { media } from '../../stores/media.svelte';
  import { cloud } from '../../stores/cloud.svelte';
  import MediaPanel from '../media/MediaPanel.svelte';
  import { MOCK_DURATION_SEC, MOCK_LINES } from '../../mock';

  type Step = { label: string; detail: string; ms: number };
  const STEPS: Step[] = [
    { label: 'FFmpeg · audio extract', detail: '-vn -ac 1 -ar 16k · 5GB in, ~20MB out', ms: 900 },
    {
      label: 'Chunk & upload',
      detail: '1.9 GB split · Groq Whisper Large v3',
      ms: 1200
    },
    {
      label: 'Whisper · transcript',
      detail: 'word + segment timestamps',
      ms: 1400
    },
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
  let timers: ReturnType<typeof setTimeout>[] = [];

  function cleanup() {
    timers.forEach(clearTimeout);
    timers = [];
  }
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
        // Real backend returns whisper output here.
        project.lines = structuredClone(MOCK_LINES);
        running = false;
      }, total + 200)
    );
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

  function useMock() {
    if (media.entries.length === 0) {
      media.addMock('apna-college-vite-intro (4k) edit.mp4', 4_780_000_000);
    }
    run();
  }
</script>

<!-- MODE 1 — INGEST · left = "My media" (Clipchamp panel), right = pipeline -->
<div class="flex min-h-0 flex-1">
  <MediaPanel />

  <div class="flex min-w-0 flex-1 flex-col">
    <div class="flex h-10 shrink-0 items-center gap-2 border-b border-nc-line bg-nc-panel px-3">
      <h2 class="text-[13px] font-semibold">Ingest &amp; Cloud Brain</h2>
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
              useMock();
            }
          }}
          role="button"
          tabindex="0"
          aria-label="Drop a video file here"
          class="nc-tie-edge flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-8 py-8 text-center transition-colors
                 {dragging ? 'border-nc-gold bg-nc-gold/5' : 'border-nc-line-2 bg-nc-panel'}"
        >
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            class="text-nc-gold"
          >
            <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
          </svg>
          <p class="text-sm font-bold">Video yahan drop karo</p>
          <p class="max-w-md text-[11px] leading-relaxed text-nc-mut">
            5 GB · 2 ghante · 4K 60FPS chalega. Video kabhi RAM me nahi jayegi — FFmpeg child
            process audio nikalega, transcript cloud pe jayega.
          </p>
          <button
            onclick={useMock}
            class="text-[11px] text-nc-mut underline underline-offset-2 hover:text-nc-gold"
          >
            …ya mock project se aage badhao
          </button>
        </div>

        <!-- pipeline -->
        <div class="rounded-xl border border-nc-line bg-nc-panel p-4">
          <div class="mb-3 flex items-center gap-2">
            <h3 class="text-[10px] font-bold tracking-widest text-nc-mut">INGEST PIPELINE</h3>
            <div class="flex-1"></div>
            <span class="font-mono text-[11px] text-nc-gold">{progress.toFixed(0)}%</span>
          </div>

          <div class="mb-4 h-1.5 overflow-hidden rounded-full bg-nc-panel-2">
            <div
              class="h-full rounded-full bg-gradient-to-r from-nc-gold to-nc-gold-dim transition-[width] duration-200"
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
                      ? 'border-nc-gold bg-nc-gold/15 text-nc-gold'
                      : 'border-nc-line-2 text-nc-mut-2'}"
                >
                  {state === 'done' ? '✓' : i + 1}
                </span>
                <span class={state === 'idle' ? 'text-nc-mut-2' : 'text-nc-txt'}>{s.label}</span>
                <span class="ml-auto font-mono text-[10px] text-nc-mut-2">{s.detail}</span>
              </li>
            {/each}
          </ol>

          {#if !running && progress >= 100 && project.lines.length > 0}
            <button
              onclick={() => mode.set('cut')}
              class="mt-4 w-full rounded-lg bg-nc-gold py-2.5 text-sm font-bold text-nc-bg hover:brightness-110"
            >
              7:3 Cut Mode mein jao →
            </button>
          {/if}
        </div>

        <p class="text-center text-[10px] leading-relaxed text-nc-mut-2">
          Prototype note: pipeline simulated hai. Real FFmpeg/Rust commands backend wiring ke baad
          <code class="text-nc-gold">lib/ipc.ts</code> ke through aayenge.
        </p>
      </div>
    </div>
  </div>
</div>
