<script lang="ts">
  import { mode } from '../../stores/mode.svelte';
  import { project } from '../../stores/project.svelte';
  import { MOCK_DURATION_SEC, MOCK_LINES, mockWaveform } from '../../mock';
  import { fmtSize } from '../../utils';

  type Step = { label: string; detail: string; ms: number };
  const STEPS: Step[] = [
    { label: 'FFmpeg · audio extract', detail: '-vn -ac 1 -ar 16k · 5GB in, ~20MB out', ms: 900 },
    { label: 'Chunk & upload', detail: '1.9 GB split · Groq Whisper Large v3', ms: 1200 },
    { label: 'Whisper · transcript', detail: 'word + segment timestamps', ms: 1400 },
    { label: 'Gemini · fumble brain', detail: 'repeat / galat-example / silence detect', ms: 1100 },
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

  function run(file: File | null) {
    if (running) return;
    running = true;
    stepIndex = -1;
    progress = 0;

    if (file) project.loadFile(file, URL.createObjectURL(file));

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
        if (!project.media) {
          project.lines = structuredClone(MOCK_LINES);
          project.waveform = mockWaveform(MOCK_DURATION_SEC);
        } else {
          // Real backend will return whisper output here.
          project.lines = structuredClone(MOCK_LINES);
          project.waveform = mockWaveform(MOCK_DURATION_SEC);
        }
        running = false;
      }, total + 200)
    );
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const f = e.dataTransfer?.files?.[0];
    if (f) run(f);
  }

  function useMock() {
    project.media = {
      id: 'mock',
      name: `${project.name}.mp4`,
      url: '',
      durationSec: MOCK_DURATION_SEC,
      width: 1920,
      height: 1080,
      fps: 60,
      sizeBytes: 4_780_000_000
    };
    run(null);
  }
</script>

<div class="flex h-full min-h-0 flex-col items-center justify-center gap-6 overflow-auto p-8">
  <!-- Drop zone -->
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
        document.getElementById('ingest-file-input')?.click();
      }
    }}
    role="button"
    tabindex="0"
    aria-label="Drop a video file here, or press Enter to browse"
    class="nc-tie-edge flex w-full max-w-3xl flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-8 py-10 text-center transition-colors
           {dragging ? 'border-nc-gold bg-nc-gold/5' : 'border-nc-line-2 bg-nc-panel'}"
  >
    <svg
      width="42"
      height="42"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      class="text-nc-gold"
    >
      <path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" />
    </svg>
    <p class="text-lg font-bold">Video yahan drop karo</p>
    <p class="max-w-md text-xs leading-relaxed text-nc-mut">
      5 GB · 2 ghante · 4K 60FPS chalega. Video kabhi RAM me nahi jayegi — FFmpeg child process
      audio nikalega, transcript cloud pe jayega.
    </p>
    <label
      class="cursor-pointer rounded-lg bg-nc-gold px-4 py-2 text-xs font-bold text-nc-bg hover:brightness-110"
    >
      Browse file
      <input
        id="ingest-file-input"
        type="file"
        accept="video/*"
        class="hidden"
        onchange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f) run(f);
        }}
      />
    </label>
    <button
      onclick={useMock}
      class="text-[11px] text-nc-mut underline underline-offset-2 hover:text-nc-gold"
    >
      …ya mock project se aage badhao
    </button>
  </div>

  <!-- Pipeline -->
  <div class="w-full max-w-3xl rounded-xl border border-nc-line bg-nc-panel p-4">
    <div class="mb-3 flex items-center gap-2">
      <h2 class="text-xs font-bold tracking-widest text-nc-mut">INGEST & CLOUD BRAIN</h2>
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

  <p class="max-w-xl text-center text-[10px] leading-relaxed text-nc-mut-2">
    Prototype note: pipeline simulated hai. Real FFmpeg/Rust commands backend wiring ke baad
    <code class="text-nc-gold">lib/ipc.ts</code> ke through aayenge.
  </p>
</div>
