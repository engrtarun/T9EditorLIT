<script lang="ts">
  /**
   * Mode 1 — Transcript & Cut.
   *
   * The dashboard from the original diagram: preview left, transcript right,
   * waveform + thumbnail timeline across the bottom.
   *
   * Only these regions exist while this mode is resident. Music and text
   * panels are not hidden with CSS — they are not rendered at all, because
   * `display: none` still costs memory.
   *
   * Chunk 2 fills the transcript with real cloud-transcribed lines; Chunk 3
   * makes the waveform interactive and wires the phantom-cut shortcuts. The
   * structure below is the contract those chunks build against.
   */
  import { project } from "../../stores/project.svelte";

  // 7:3 split — preview gets the space, transcript gets enough to scan
  // Hindi lines without wrapping every other word.
  const layout = "grid min-h-0 flex-1 grid-cols-[7fr_3fr] grid-rows-[minmax(0,1fr)_auto]";
</script>

<div class="flex min-h-0 flex-1 flex-col bg-base-950">
  {#if !project.hasMedia}
    <!-- ── Empty state ───────────────────────────────────────────── -->
    <div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div
        class="flex h-14 w-14 items-center justify-center rounded-xl border border-base-700 bg-base-900"
        aria-hidden="true"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-nanami-rose)"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M10 9l5 3-5 3z" />
        </svg>
      </div>
      <h2 class="text-base font-semibold text-nanami-blush">Load a source video to begin</h2>
      <p class="max-w-md text-[13px] leading-relaxed text-ink-500">
        Pick a recording up to 5&nbsp;GB. T9EditorLIT probes it with
        <code class="mono text-nanami-sage">ffprobe</code> — the file itself is never loaded into memory.
      </p>
    </div>
  {:else}
    <div class={layout}>
      <!-- ── LEFT: Video preview ──────────────────────────────────── -->
      <section class="flex min-h-0 min-w-0 flex-col gap-1.5 p-3 pb-0">
        <div class="panel-label">Video preview</div>
        <div
          class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-black"
        >
          <!--
            The <video> element arrives with Chunk 3. It is pointed at the file
            via a Tauri asset protocol URL and streams from disk; the 5 GB file
            is never buffered into RAM. Segments marked ✕ are skipped on
            timeupdate, which is the Phantom Cut.
          -->
          <div class="flex flex-col items-center gap-1.5 text-center">
            <span class="mono text-[11px] text-ink-500">
              preview mounts here once the source is attached to the player
            </span>
            <span class="mono text-[10px] text-base-500">
              streams from disk · ✕ segments skipped on the fly
            </span>
          </div>
        </div>
      </section>

      <!-- ── RIGHT: Transcript ────────────────────────────────────── -->
      <section class="flex min-h-0 min-w-0 flex-col gap-1.5 p-3 pb-0">
        <div class="flex items-center justify-between">
          <span class="panel-label">Transcript</span>
          <span class="mono text-[10px] text-ink-500" title="Shortcuts: X = cut, V = keep">
            X cut · V keep
          </span>
        </div>
        <div class="panel flex min-h-0 flex-1 flex-col overflow-hidden">
          <!--
            Virtual scroll lands here in Chunk 3. A 2-hour video carries
            thousands of lines; rendering them all would fill the heap, so only
            the ~30 lines inside the viewport are ever in the DOM.
          -->
          <div class="flex flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center">
            <span class="text-[12px] text-ink-500">transcript appears in Chunk 2</span>
            <span class="mono text-[10px] text-base-500">
              Groq Whisper · Gemini flags retakes
            </span>
          </div>
        </div>
      </section>

      <!-- ── BOTTOM: Waveform + thumbnails ────────────────────────── -->
      <section class="flex min-w-0 flex-col gap-1.5 p-3">
        <div class="panel-label">Audio waveform</div>
        <div class="panel h-16 shrink-0 overflow-hidden">
          <!--
            Chunk 3: multi-resolution peaks rendered to a small canvas from
            FFmpeg-extracted amplitude data. Speech and dead air have visibly
            different shapes, which is what makes long silences findable by eye.
          -->
          <div class="flex h-full items-center justify-center">
            <span class="mono text-[10px] text-base-500">peaks rendered from extracted audio</span>
          </div>
        </div>

        <div class="panel-label">Video timeline</div>
        <div class="panel h-14 shrink-0 overflow-hidden">
          <!--
            Chunk 3: thumbnail strip sampled by FFmpeg at ~1 fps. Generated
            once on load and cached as small JPEGs on disk.
          -->
          <div class="flex h-full items-center justify-center">
            <span class="mono text-[10px] text-base-500">FPS thumbnail strip</span>
          </div>
        </div>
      </section>
    </div>
  {/if}
</div>
