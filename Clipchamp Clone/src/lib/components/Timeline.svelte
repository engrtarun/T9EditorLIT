<script lang="ts">
  import { editor } from "$lib/editor.svelte";
  import { formatTimecode, snap } from "$lib/timeline";
  import type { Clip, Track } from "$lib/types";

  const RULER_H = 26;
  const LABEL_W = 132;

  /** Seconds per major tick; halves as you zoom past a threshold. */
  const tickStep: number = $derived(
    editor.zoomPxPerSec > 120 ? 1 : editor.zoomPxPerSec > 45 ? 5 : 10,
  );
  const ticks: number[] = $derived.by(() => {
    const span = Math.max(editor.durationSecs, 10);
    const out: number[] = [];
    for (let t = 0; t <= span; t += tickStep) out.push(t);
    return out;
  });

  const trackColor: Record<Track["kind"], string> = {
    video: "bg-sky-500/25 ring-sky-500/40",
    overlay: "bg-violet-500/25 ring-violet-500/40",
    audio: "bg-emerald-500/25 ring-emerald-500/40",
    caption: "bg-amber-500/25 ring-amber-500/40",
  };

  function clipStyle(c: Clip): string {
    return `left:${c.startSecs * editor.zoomPxPerSec}px;width:${Math.max(2, c.durationSecs * editor.zoomPxPerSec)}px`;
  }

  /** Click on the ruler seeks; drag on empty track space scrubs. */
  function seekFromEvent(e: MouseEvent): void {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    editor.seek((e.clientX - rect.left) / editor.zoomPxPerSec);
  }

  let scrubbing = $state(false);

  function startScrub(e: MouseEvent) {
    scrubbing = true;
    seekFromEvent(e);
    const onMove = (ev: MouseEvent) => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      editor.seek((ev.clientX - rect.left) / editor.zoomPxPerSec);
    };
    const onUp = () => {
      scrubbing = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** Drag a clip body to move it. */
  function startDrag(c: Clip, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    editor.selectedClipId = c.id;

    const grabOffset = e.clientX / editor.zoomPxPerSec - c.startSecs;
    const originStart = c.startSecs;
    editor.begin();

    const onMove = (ev: MouseEvent) => {
      const desired = ev.clientX / editor.zoomPxPerSec - grabOffset;
      // Snap to whole seconds while dragging: cheap and predictable.
      editor.moveSelected(snap(desired, 1, 0), 0);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Collapse to one undo step only if the clip actually moved.
      const now = editor.selectedClip;
      if (now && Math.abs(now.startSecs - originStart) < 1e-6) editor.revert();
      else editor.commit();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /** Drag a clip's right edge to trim. */
  function startTrim(c: Clip, e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    editor.selectedClipId = c.id;
    editor.begin();

    const originDuration = c.durationSecs;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.movementX / editor.zoomPxPerSec;
      editor.trimSelectedEnd(originDuration + delta);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const now = editor.selectedClip;
      if (now && Math.abs(now.durationSecs - originDuration) < 1e-6) editor.revert();
      else editor.commit();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
</script>

<section class="flex h-56 shrink-0 flex-col border-t border-panel-border bg-panel">
  <!-- Zoom -->
  <div class="flex h-8 shrink-0 items-center gap-3 border-b border-panel-border px-3">
    <h2 class="text-xs font-medium text-zinc-300">Timeline</h2>
    <span class="text-[10px] text-zinc-500">{editor.clips.length} clips</span>
    <label class="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
      Zoom
      <input
        type="range"
        min="12"
        max="240"
        step="1"
        value={editor.zoomPxPerSec}
        oninput={(e) => (editor.zoomPxPerSec = Number(e.currentTarget.value))}
        class="w-28 accent-[var(--color-accent)]"
        aria-label="Timeline zoom"
      />
    </label>
  </div>

  <div class="flex min-h-0 flex-1">
    <!-- Track labels -->
    <div class="shrink-0 border-r border-panel-border" style="width:{LABEL_W}px">
      <div class="border-b border-panel-border" style="height:{RULER_H}px"></div>
      {#each editor.tracks as track (track.id)}
        <div
          class="flex items-center gap-1.5 border-b border-panel-border/60 px-2"
          style="height:{track.heightPx}px"
        >
          <span class="size-1.5 shrink-0 rounded-full bg-zinc-600" aria-hidden="true"></span>
          <span class="min-w-0 flex-1 truncate text-[11px] text-zinc-400">{track.name}</span>
          <button
            type="button"
            class="text-[10px] text-zinc-600 hover:text-zinc-300"
            onclick={() => (track.muted = !track.muted)}
            title={track.muted ? "Unmute track" : "Mute track"}
          >
            {track.muted ? "🔇" : "🔊"}
          </button>
        </div>
      {/each}
    </div>

    <!-- Scrolling lane: ruler + tracks, all sharing one horizontal scroll -->
    <div class="min-w-0 flex-1 overflow-x-auto overflow-y-auto">
      <div
        class="relative"
        style="width:{Math.max((editor.durationSecs + 10) * editor.zoomPxPerSec, 600)}px"
      >
        <!-- Ruler -->
        <div
          class="sticky top-0 z-20 cursor-col-resize border-b border-panel-border bg-panel"
          style="height:{RULER_H}px"
          onmousedown={startScrub}
          role="presentation"
        >
          {#each ticks as t (t)}
            <div
              class="absolute top-0 h-full border-l border-panel-border/70 pt-1 pl-1 text-[10px] text-zinc-600"
              style="left:{t * editor.zoomPxPerSec}px"
            >
              {formatTimecode(t)}
            </div>
          {/each}
        </div>

        <!-- Tracks -->
        {#each editor.tracks as track (track.id)}
          <div
            class="relative border-b border-panel-border/60 {scrubbing ? '' : 'cursor-default'}"
            style="height:{track.heightPx}px"
            onmousedown={(e) => {
              editor.selectedClipId = null;
              seekFromEvent(e);
            }}
            role="presentation"
          >
            {#each editor.clipsOn(track.id) as c (c.id)}
              {@const selected = editor.selectedClipId === c.id}
              <div
                class="group absolute top-1 bottom-1 cursor-grab overflow-hidden rounded
                       ring-1 transition-[box-shadow] {trackColor[track.kind]}
                       {selected ? 'ring-2 ring-accent' : ''}"
                style={clipStyle(c)}
                onmousedown={(e) => startDrag(c, e)}
                role="button"
                tabindex="0"
                aria-label="Clip {c.id}"
              >
                <span
                  class="pointer-events-none block truncate px-1.5 py-1 text-[10px] text-zinc-100/90"
                >
                  {editor.assetById(c.assetId)?.path.split(/[\\/]/).pop() ?? c.id}
                </span>
                {#if c.transition}
                  <span
                    class="pointer-events-none absolute top-0 left-0 h-full w-6 bg-gradient-to-r from-white/30 to-transparent"
                    title="Transition: {c.transition}"
                  ></span>
                {/if}
                <!-- Trim handle -->
                <span
                  class="absolute top-0 right-0 h-full w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/40"
                  onmousedown={(e) => startTrim(c, e)}
                  role="presentation"
                ></span>
              </div>
            {/each}
          </div>
        {/each}

        <!-- Playhead spans ruler + every track -->
        <div
          class="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-red-500"
          style="left:{editor.playheadSecs * editor.zoomPxPerSec}px"
          aria-hidden="true"
        ></div>
      </div>
    </div>
  </div>
</section>
