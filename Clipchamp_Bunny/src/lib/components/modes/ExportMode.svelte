<script lang="ts">
  import { mode } from '../../stores/mode.svelte';
  import { project } from '../../stores/project.svelte';
  import { fmtHuman, fmtSize } from '../../utils';

  type Engine = 'smart' | 'hardware' | 'cpu';
  const ENGINES: Array<{ id: Engine; label: string; note: string }> = [
    {
      id: 'smart',
      label: 'Smart / Lossless',
      note: '-c copy · cut points keyframe se align · 0% quality loss'
    },
    {
      id: 'hardware',
      label: 'Hardware (QSV)',
      note: 'Intel Quick Sync iGPU · 1080p/4K 60fps re-encode'
    },
    { id: 'cpu', label: 'CPU fallback', note: 'libx264 · sabse reliable, sabse slow' }
  ];

  let engine = $state<Engine>('smart');
  let exporting = $state(false);
  let exportPct = $state(0);
  let vaultOn = $state(true);
  let vaultPct = $state(0);
  let done = $state(false);
  let timers: ReturnType<typeof setTimeout>[] = [];

  function cleanup() {
    timers.forEach(clearTimeout);
    timers = [];
  }
  $effect(() => cleanup);

  function start() {
    if (exporting) return;
    exporting = true;
    done = false;
    exportPct = 0;
    vaultPct = 0;

    // ~2 s of fake export, then ~3 s of fake vault upload
    for (let p = 5; p <= 100; p += 5) {
      timers.push(
        setTimeout(() => {
          exportPct = p;
          if (p === 100) {
            done = true;
            exporting = false;
          }
        }, p * 20)
      );
    }
    if (vaultOn) {
      for (let p = 4; p <= 100; p += 4) {
        timers.push(
          setTimeout(
            () => {
              vaultPct = p;
            },
            2400 + p * 45
          )
        );
      }
    }
  }

  const estimate = $derived(
    engine === 'smart' ? '1–2 min' : engine === 'hardware' ? '~6 min' : '~25 min'
  );
</script>

<div class="flex min-w-0 flex-1 flex-col">
  <div class="flex h-11 shrink-0 items-center gap-2 border-b border-nc-line px-3">
    <h2 class="text-xs font-bold tracking-wider">LIGHTNING EXPORT & TG VAULT</h2>
    <div class="flex-1"></div>
    <button
      onclick={() => mode.set('polish')}
      class="rounded-lg border border-nc-line px-3 py-1 text-xs text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
    >
      ← Polish
    </button>
  </div>

  <div class="nc-scroll min-h-0 flex-1 p-6">
    <!-- summary -->
    <div class="mx-auto max-w-3xl space-y-5">
      <div class="grid grid-cols-3 gap-3">
        <div class="rounded-xl border border-nc-line bg-nc-panel p-4">
          <p class="text-[10px] tracking-widest text-nc-mut">RAW</p>
          <p class="mt-1 font-mono text-xl text-nc-mut-2">{fmtHuman(project.durationSec)}</p>
        </div>
        <div class="rounded-xl border border-nc-gold/40 bg-nc-gold/5 p-4">
          <p class="text-[10px] tracking-widest text-nc-gold">FINAL</p>
          <p class="mt-1 font-mono text-xl text-nc-gold">{fmtHuman(project.keptSec)}</p>
        </div>
        <div class="rounded-xl border border-nc-red/40 bg-nc-red/5 p-4">
          <p class="text-[10px] tracking-widest text-nc-red">KACHRA CUT 🔥</p>
          <p class="mt-1 font-mono text-xl text-nc-red">{fmtHuman(project.cutSec)}</p>
        </div>
      </div>

      <!-- engine -->
      <div>
        <p class="mb-2 text-[10px] tracking-widest text-nc-mut">EXPORT ENGINE</p>
        <div class="grid gap-2">
          {#each ENGINES as e (e.id)}
            <button
              onclick={() => (engine = e.id)}
              class="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors
                     {engine === e.id
                ? 'border-nc-gold bg-nc-gold/5'
                : 'border-nc-line bg-nc-panel hover:border-nc-line-2'}"
            >
              <span
                class="grid h-4 w-4 shrink-0 place-items-center rounded-full border
                       {engine === e.id ? 'border-nc-gold' : 'border-nc-line-2'}"
              >
                {#if engine === e.id}<span class="h-2 w-2 rounded-full bg-nc-gold"></span>{/if}
              </span>
              <span>
                <span class="block text-xs font-semibold">{e.label}</span>
                <span class="block text-[10px] text-nc-mut">{e.note}</span>
              </span>
              <span class="ml-auto font-mono text-[10px] text-nc-mut">est {estimate}</span>
            </button>
          {/each}
        </div>
      </div>

      <!-- vault -->
      <label
        class="flex cursor-pointer items-center gap-3 rounded-lg border border-nc-line bg-nc-panel px-3 py-2.5"
      >
        <input type="checkbox" bind:checked={vaultOn} class="h-4 w-4 accent-nc-gold" />
        <span>
          <span class="block text-xs font-semibold">Telegram Vault backup</span>
          <span class="block text-[10px] text-nc-mut"
            >MTProto user API · 512 KB chunks · 3–4 sockets · 1.9 GB split</span
          >
        </span>
      </label>

      <!-- action -->
      <button
        onclick={start}
        disabled={exporting}
        class="w-full rounded-xl bg-nc-gold py-3.5 text-sm font-bold text-nc-bg transition hover:brightness-110 disabled:opacity-50"
      >
        {exporting ? `Exporting… ${exportPct}%` : '▶ EXPORT FINAL VIDEO'}
      </button>

      <div class="space-y-3">
        <div>
          <div class="mb-1 flex text-[10px] text-nc-mut">
            <span>ffmpeg {engine}</span>
            <span class="ml-auto font-mono">{exportPct.toFixed(0)}%</span>
          </div>
          <div class="h-2 overflow-hidden rounded-full bg-nc-panel-2">
            <div
              class="h-full bg-gradient-to-r from-nc-gold to-nc-green transition-[width] duration-150"
              style="width:{exportPct}%"
            ></div>
          </div>
        </div>

        {#if vaultOn}
          <div>
            <div class="mb-1 flex text-[10px] text-nc-mut">
              <span>t9cloud → Telegram</span>
              <span class="ml-auto font-mono">{vaultPct.toFixed(0)}%</span>
            </div>
            <div class="h-2 overflow-hidden rounded-full bg-nc-panel-2">
              <div
                class="h-full bg-gradient-to-r from-nc-green to-nc-gold transition-[width] duration-150"
                style="width:{vaultPct}%"
              ></div>
            </div>
          </div>
        {/if}
      </div>

      {#if done}
        <div class="nc-tie-edge rounded-xl border border-nc-gold/40 bg-nc-gold/5 p-5 text-center">
          <p class="text-base font-bold text-nc-gold">Kaam khatam. Ab aaram karo.</p>
          <p class="mt-1 text-xs text-nc-mut">
            {project.cutCount} lines kat gayi · {fmtHuman(project.cutSec)} bacha · source
            {project.media ? ` (${fmtSize(project.media.sizeBytes)})` : ''} untouched
          </p>
          <p class="mt-3 text-[10px] text-nc-mut-2">
            7:3 ratio. Ek strike me kaam khatam. — Nanami
          </p>
        </div>
      {/if}
    </div>
  </div>
</div>
