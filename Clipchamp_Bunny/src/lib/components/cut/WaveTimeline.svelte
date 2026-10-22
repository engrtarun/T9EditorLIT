<script lang="ts">
  import { project } from '../../stores/project.svelte';
  import { player } from '../../stores/player.svelte';
  import { layout } from '../../stores/layout.svelte';
  import { settings } from '../../stores/settings.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { thumbUrl } from '../../media';
  import { dropIndex } from '../../segments';
  import { clamp, fmtShort, fmtTime, niceStep } from '../../utils';
  import ContextMenu from '../ContextMenu.svelte';
  import MenuIcon from '../MenuIcon.svelte';
  import type { MenuItem } from '../../types';

  /* Timeline metrics (measured on the Clipchamp OBS capture + DOM extract):
     tool row 30px · source minimap 7px · ruler 24px
     video lane 52px · audio lane 44px

     The block is drag-resizable from its top edge: everything above the two
     media lanes is fixed at these metrics, and `layout.timelineHeight`
     (the whole section, borders included) hands the leftover to the video/audio
     lanes in Clipchamp's 52:44 ratio.

     There is **no text lane**: text overlays are not part of the app right
     now, so the user cannot create, move or trim text on the timeline. */
  const MINIMAP_H = 7;
  const RULER_H = 24;
  /* border-t 1 + resize strip 3 + tool row 30 + minimap 7 + ruler 24 */
  const FIXED_H = 65;
  const LANES_H = $derived(Math.max(55, layout.timelineHeight - FIXED_H));
  const VIDEO_H = $derived(Math.round((LANES_H * 52) / 96));
  const AUDIO_H = $derived(LANES_H - VIDEO_H);

  let wrap: HTMLDivElement | null = $state(null);
  let filmCanvas: HTMLCanvasElement | null = $state(null);
  let waveCanvas: HTMLCanvasElement | null = $state(null);
  let miniCanvas: HTMLCanvasElement | null = $state(null);
  let laneEl: HTMLDivElement | null = $state(null);
  let viewW = $state(1200);
  let scrollLeft = $state(0);
  let busy = $state(false);

  /* ---- clip drag state ---- */
  let dragId: string | null = $state(null);
  let dragDx = $state(0);
  let lastClickedSegId: string | null = $state(null);

  type TrimEdge = 'start' | 'end';
  interface ClipTrim {
    segId: string;
    edge: TrimEdge;
    /** Source seconds the edge is currently previewing. */
    targetSec: number;
    /** Source seconds before the drag began. */
    originSec: number;
  }
  let trim = $state<ClipTrim | null>(null);

  /* ---- context menu ---- */
  interface CtxState {
    x: number;
    y: number;
    segId: string;
  }
  let ctx = $state<CtxState | null>(null);

  const zoom = $derived(player.zoom);
  /** The timeline is the EDIT timeline: the final video, gapless. */
  const editDur = $derived(project.editDuration || project.durationSec);
  const contentW = $derived(Math.max(600, (editDur + 4) * zoom));
  const step = $derived(niceStep(zoom));
  const minor = $derived(step / (step >= 5 ? 5 : step >= 2 ? 4 : 2));

  const ticks = $derived.by(() => {
    const out: Array<{ t: number; major: boolean }> = [];
    for (let t = 0; t <= editDur + 0.001 && out.length < 3000; t += minor) {
      out.push({ t, major: Math.abs(t / step - Math.round(t / step)) < 1e-6 });
    }
    return out;
  });

  const segments = $derived(project.orderedSegments);
  const offsets = $derived(project.segmentOffsets);

  /* ---------------------------------------------------------------- thumbs
     Only the frames inside the viewport are fetched, so a 2-hour timeline
     never pulls thousands of JPEGs into the heap. */
  const thumbImgs = new Map<number, HTMLImageElement>();

  function ensureThumbs(fromSec: number, toSec: number) {
    const strip = project.thumbnails;
    if (!strip) return;
    const i0 = Math.max(0, Math.floor(fromSec * strip.fps));
    const i1 = Math.min(strip.count - 1, Math.ceil(toSec * strip.fps));
    for (let i = i0; i <= i1; i++) {
      if (thumbImgs.has(i)) continue;
      const img = new Image();
      img.decoding = 'async';
      img.src = thumbUrl(strip, i);
      img.onload = () => drawVideoLane();
      thumbImgs.set(i, img);
    }
    if (thumbImgs.size > 260) {
      for (const k of [...thumbImgs.keys()]) {
        if (k < i0 - 80 || k > i1 + 80) thumbImgs.delete(k);
      }
    }
  }

  /* ---------------------------------------------------------------- colours
     gold = keep · red = fumble / repeat / galat example · grey = khamoshi */
  const BUCKET = 0.25;
  const colours = $derived.by(() => {
    const n = Math.ceil((project.durationSec + 4) / BUCKET);
    const out = new Array<string>(n).fill('#3a3d4c');
    for (const l of project.lines) {
      const c = l.flag === 'silence' ? '#4a4d5c' : l.keep === 'cut' ? '#e5484d' : '#d4af37';
      const from = Math.max(0, Math.floor(l.startSec / BUCKET));
      const to = Math.min(n - 1, Math.ceil(l.endSec / BUCKET));
      for (let i = from; i <= to; i++) out[i] = c;
    }
    return out;
  });

  function sourceColour(sourceSec: number): string {
    const i = Math.min(colours.length - 1, Math.max(0, Math.floor(sourceSec / BUCKET)));
    return colours[i] ?? '#3a3d4c';
  }

  /* ---------------------------------------------------------------- drawing */
  function drawVideoLane() {
    const c = filmCanvas;
    if (!c) return;
    const w = contentW;
    c.width = w;
    c.height = VIDEO_H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, VIDEO_H);

    const strip = project.thumbnails;
    for (const s of segments) {
      const off = offsets.get(s.id);
      if (!off) continue;
      const x0 = off.start * zoom;
      const x1 = off.end * zoom;
      if (x1 < 0 || x0 > w) continue;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, VIDEO_H);
      ctx.clip();
      if (strip) {
        const i0 = Math.max(0, Math.floor(s.startSec * strip.fps));
        const i1 = Math.min(strip.count - 1, Math.floor(s.endSec * strip.fps));
        for (let i = i0; i <= i1; i++) {
          const img = thumbImgs.get(i);
          if (!img || !img.complete || !img.naturalWidth) continue;
          // the source frame, drawn at its position inside the segment
          const local = (i / strip.fps - s.startSec) * zoom;
          ctx.drawImage(img, x0 + local, 0, Math.max(1, zoom), VIDEO_H);
        }
      }
      ctx.restore();
    }

    // Split dividers — every split the user made stays visible, even when both
    // halves are kept (otherwise a split looks like it did nothing).
    ctx.fillStyle = 'rgba(212,175,55,0.95)';
    for (const x of project.splitMarkPositions) {
      const px = x * zoom;
      if (px < 0 || px > w) continue;
      ctx.fillRect(px - 0.5, 0, 1.5, VIDEO_H);
    }
  }

  function drawWave() {
    const c = waveCanvas;
    const peaks = project.waveform?.peaks;
    if (!c) return;
    const w = contentW;
    c.width = w;
    c.height = AUDIO_H;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#14151d';
    ctx.fillRect(0, 0, w, AUDIO_H);
    const mid = AUDIO_H / 2;
    const dur = project.durationSec || 1;

    for (const s of segments) {
      const off = offsets.get(s.id);
      if (!off || !peaks?.length) continue;
      const x0 = off.start * zoom;
      const x1 = off.end * zoom;
      const wpx = Math.max(1, Math.ceil(x1 - x0));
      // A muted clip still shows its shape, just ghosted — Clipchamp keeps the
      // waveform visible so the user can see what is muted.
      ctx.globalAlpha = project.isSegmentMuted(s.id) ? 0.28 : 1;
      for (let px = 0; px < wpx; px += 2) {
        const sourceSec = s.startSec + px / zoom;
        const pi = Math.min(peaks.length - 1, Math.floor((sourceSec / dur) * peaks.length));
        const p = peaks[Math.max(0, pi)] ?? 0;
        const hgt = Math.max(1, p * (AUDIO_H - 10));
        ctx.fillStyle = sourceColour(sourceSec);
        ctx.fillRect(x0 + px, mid - hgt / 2, 2, hgt);
      }
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#2a2c38';
    ctx.fillRect(0, mid, w, 1);
  }

  /** The source minimap: the whole original video, red where it is cut. */
  function drawMinimap() {
    const c = miniCanvas;
    if (!c) return;
    const w = Math.max(600, project.durationSec * 2);
    c.width = w;
    c.height = MINIMAP_H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#1a1c26';
    ctx.fillRect(0, 0, w, MINIMAP_H);
    for (const l of project.lines) {
      if (l.keep === 'keep') continue;
      ctx.fillStyle = 'rgba(229,72,77,.75)';
      ctx.fillRect(l.startSec * 2, 0, Math.max(1, (l.endSec - l.startSec) * 2), MINIMAP_H);
    }
  }

  $effect(() => {
    void project.waveform;
    void project.mutedSegments;
    void zoom;
    void contentW;
    void colours;
    void segments;
    void offsets;
    void project.splitMarkPositions;
    void LANES_H; // lane heights are drag-resizable — redraw on resize
    drawWave();
    drawVideoLane();
    drawMinimap();
  });

  /* ---------------------------------------------------------------- viewport */
  $effect(() => {
    const w = wrap;
    if (!w) return;
    const z = zoom;
    const sl = scrollLeft;
    viewW = w.clientWidth;
    // source range currently visible on the edit timeline
    let from = Infinity;
    let to = -Infinity;
    for (const s of segments) {
      const off = offsets.get(s.id);
      if (!off) continue;
      const a = off.start * z;
      const b = off.end * z;
      if (b < sl - 200 || a > sl + viewW + 200) continue;
      from = Math.min(from, s.startSec);
      to = Math.max(to, s.endSec);
    }
    if (Number.isFinite(from)) ensureThumbs(from, to);
    drawVideoLane();
    const obs = new ResizeObserver(() => (viewW = w.clientWidth));
    obs.observe(w);
    return () => obs.disconnect();
  });

  /* ---------------------------------------------------------------- actions */
  function seekFromEvent(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const editSec = clamp((e.clientX - rect.left) / zoom, 0, editDur);
    const source = project.sourceAt(editSec);
    if (source != null) player.seek(project.snapTime(source));
  }

  /** Clicking blank timeline clears the selection, then moves the playhead. */
  function onLaneClick(e: MouseEvent) {
    project.deselectAll();
    lastClickedSegId = null;
    seekFromEvent(e);
  }

  function laneKeys(e: KeyboardEvent) {
    const small = e.shiftKey ? 1 : 1 / 30;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      player.nudge(-small);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      player.nudge(small);
    }
  }

  const aria = $derived({
    role: 'slider',
    tabindex: 0,
    'aria-label': 'Timeline',
    'aria-valuemin': 0,
    'aria-valuemax': Math.round(editDur),
    'aria-valuenow': Math.round(player.currentTime)
  });

  function nudgeZoom(dir: 1 | -1) {
    player.zoom = clamp(zoom * (dir === 1 ? 1.4 : 1 / 1.4), 4, 220);
  }

  function zoomFit() {
    const w = wrap?.clientWidth ?? 1200;
    player.zoom = clamp(w / Math.max(editDur, 1), 4, 220);
  }

  function doSplit() {
    if (project.splitAt(player.currentTime)) {
      player.seek(project.snapTime(player.currentTime));
      toast.push('split', `✂ Split at ${fmtTime(player.currentTime)}`);
    } else {
      toast.push('warn', '✂ Split nahi hua — line bahut chhoti hai');
    }
  }

  /** Clipchamp's "AI suggestions" — auto-cut the long silences. */
  async function autoCut() {
    if (busy) return;
    busy = true;
    toast.push('info', 'AI: scanning for silences…');
    try {
      const n = await project.autoCutSilence(3.0);
      toast.push(
        n ? 'cut' : 'info',
        n ? `✕ ${n} lines cut (silence ≥ 3s)` : 'AI: koi 3s+ silence nahi mili'
      );
    } catch (e) {
      toast.push('warn', `AI scan failed: ${e instanceof Error ? e.message : e}`);
    }
    busy = false;
  }

  /* --------------------------------------------------------------- selection */
  type SelectMods = { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean };
  function selectSegment(seg: (typeof segments)[number], e?: SelectMods) {
    const ids = seg.lines.map((l) => l.id);
    if (e?.shiftKey && lastClickedSegId) {
      const a = segments.findIndex((s) => s.id === lastClickedSegId);
      const b = segments.findIndex((s) => s.id === seg.id);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const range = segments.slice(lo, hi + 1).flatMap((s) => s.lines.map((l) => l.id));
        project.selectMany(range, e.ctrlKey || e.metaKey);
      } else {
        project.selectMany(ids, e.ctrlKey || e.metaKey);
      }
    } else if (e?.ctrlKey || e?.metaKey) {
      project.toggleMany(ids);
    } else {
      project.selectMany(ids);
    }
    lastClickedSegId = seg.id;
    const first = project.lines.findIndex((l) => l.id === seg.lines[0]?.id);
    if (first >= 0) project.cursor = first;
  }

  function segmentSelection(seg: (typeof segments)[number]): 'none' | 'some' | 'all' {
    let n = 0;
    for (const l of seg.lines) if (project.isSelected(l.id)) n++;
    if (n === 0) return 'none';
    return n === seg.lines.length ? 'all' : 'some';
  }

  /* --------------------------------------------------------------- dragging */
  function onClipDown(e: PointerEvent, seg: (typeof segments)[number]) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectSegment(seg, e);
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;

    const startX = e.clientX;
    let moved = false;
    let dx = 0;

    const move = (ev: PointerEvent) => {
      dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      dragId = seg.id;
      dragDx = dx;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const id = dragId;
      dragId = null;
      dragDx = 0;
      if (!moved) {
        // A plain click selects and reveals the clip's first frame.
        player.seek(seg.startSec);
        return;
      }
      if (!id || !laneEl) return;

      const rect = laneEl.getBoundingClientRect();
      const editSec = clamp((ev.clientX - rect.left) / zoom, 0, editDur);
      const from = segments.findIndex((s) => s.id === id);
      const target = dropIndex(segments, offsets, id, editSec);
      if (target !== from) {
        project.moveSegment(id, target);
        toast.push('info', 'Clip moved — transcript reordered');
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Pull a clip edge inward. Snapping still applies, and whole lines that
   *  disappear past the edge become cuts, so the gap closes on release. */
  function onTrimDown(e: PointerEvent, seg: (typeof segments)[number], edge: TrimEdge) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectSegment(seg, e);

    const startX = e.clientX;
    const origin = edge === 'start' ? seg.startSec : seg.endSec;
    const lo = edge === 'start' ? seg.startSec + 0.02 : seg.startSec + 0.3;
    const hi = edge === 'start' ? seg.endSec - 0.3 : seg.endSec - 0.02;
    let target = origin;

    const move = (ev: PointerEvent) => {
      target = clamp(origin + (ev.clientX - startX) / zoom, lo, hi);
      if (project.snap) {
        const snapped = project.snapTime(target, 0.08);
        if (snapped > lo && snapped < hi) target = snapped;
      }
      trim = { segId: seg.id, edge, targetSec: target, originSec: origin };
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const t = trim;
      trim = null;
      if (!t || Math.abs(t.targetSec - t.originSec) < 0.02) return;
      const ok =
        edge === 'start'
          ? project.trimSegmentStartTo(t.segId, t.targetSec)
          : project.trimSegmentEndTo(t.segId, t.targetSec);
      if (ok) toast.push('cut', edge === 'start' ? 'Clip start trimmed' : 'Clip end trimmed');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Drag the playhead: x → edit seconds → source seconds. */
  function onPlayheadDown(e: PointerEvent) {
    if (e.button !== 0 || !wrap) return;
    e.preventDefault();
    e.stopPropagation();
    const el = wrap;

    const seek = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left + el.scrollLeft;
      const editSec = clamp(x / zoom, 0, editDur);
      const source = project.sourceAt(editSec);
      if (source != null) player.seek(project.snapTime(source, 0.12));
    };
    const up = () => {
      window.removeEventListener('pointermove', seek);
      window.removeEventListener('pointerup', up);
    };
    seek(e);
    window.addEventListener('pointermove', seek);
    window.addEventListener('pointerup', up);
  }

  /* ------------------------------------------------------------ context menu */
  function openClipMenu(e: MouseEvent, seg: (typeof segments)[number]) {
    e.preventDefault();
    e.stopPropagation();
    selectSegment(seg, e);
    ctx = { x: e.clientX, y: e.clientY, segId: seg.id };
  }

  const clipMenuItems = $derived.by((): MenuItem[] => {
    const c = ctx;
    const seg = c?.segId ? segments.find((s) => s.id === c.segId) : null;
    if (!seg) return [];
    const inside =
      player.currentTime > seg.startSec + 0.15 && player.currentTime < seg.endSec - 0.15;
    const muted = project.isSegmentMuted(seg.id);
    return [
      { id: 'split', label: 'Split at playhead', icon: 'split', disabled: !inside },
      { id: 'trim-start', label: 'Trim start to playhead', icon: 'scissors', disabled: !inside },
      { id: 'trim-end', label: 'Trim end to playhead', icon: 'scissors', disabled: !inside },
      { id: 'div-1', label: '', divider: true },
      {
        id: 'mute',
        label: muted ? 'Unmute clip audio' : 'Mute clip audio',
        icon: muted ? 'volumeOff' : 'volume'
      },
      { id: 'div-2', label: '', divider: true },
      { id: 'delete', label: 'Delete clip (closes gap)', icon: 'trash', danger: true }
    ];
  });

  function onMenuChoose(id: string) {
    const c = ctx;
    ctx = null;
    if (!c) return;

    const seg = c.segId ? segments.find((s) => s.id === c.segId) : null;
    if (!seg) return;
    if (id === 'split') {
      if (project.splitAt(player.currentTime)) {
        player.seek(project.snapTime(player.currentTime));
        toast.push('split', '✂ Clip split');
      } else {
        toast.push('warn', 'Split nahi hua — playhead line ke andar rakho');
      }
    } else if (id === 'trim-start') {
      if (project.trimSegmentStartTo(seg.id, player.currentTime))
        toast.push('cut', 'Clip start trimmed');
      else toast.push('warn', 'Trim start nahi hua');
    } else if (id === 'trim-end') {
      if (project.trimSegmentEndTo(seg.id, player.currentTime))
        toast.push('cut', 'Clip end trimmed');
      else toast.push('warn', 'Trim end nahi hua');
    } else if (id === 'mute') {
      project.toggleSegmentMute(seg.id);
      toast.push(
        'info',
        project.isSegmentMuted(seg.id) ? 'Clip audio muted' : 'Clip audio unmuted'
      );
    } else if (id === 'delete') {
      project.cutSegments([seg.id]);
      toast.push('cut', '✕ Clip deleted — gap closed');
    }
  }

  /** Playhead on the edit timeline. */
  const editPlayhead = $derived(project.editTimeAt(player.currentTime));

  /** Drag the top edge: up = taller, down = shorter. Double-click resets. */
  function startHeightResize(e: PointerEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = layout.timelineHeight;
    const move = (ev: PointerEvent) => layout.setTimelineHeight(startH - (ev.clientY - startY));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
</script>

<!-- BOTTOM BLOCK — the EDIT timeline: the final video, gapless, with draggable clips. -->
<section
  data-focus="timeline"
  tabindex="-1"
  class="relative flex shrink-0 flex-col border-t border-nc-line bg-nc-panel outline-none"
  style="height:{layout.timelineCollapsed ? 31 : layout.timelineHeight}px"
>
  {#if !layout.timelineCollapsed}
    <!-- top-edge separator — drag up/down to resize, double-click resets to 191px -->
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize timeline"
      title="Drag to resize — double-click to reset"
      onpointerdown={startHeightResize}
      ondblclick={() => layout.resetTimelineHeight()}
      class="h-[3px] shrink-0 cursor-row-resize bg-nc-line transition-colors hover:bg-nc-brand/60"
    ></div>
  {/if}
  <!-- TOOL ROW: tools left, transport centred, legend + track eyes right. -->
  <div class="relative flex h-[30px] shrink-0 items-center gap-1 border-b border-nc-line px-2">
    <div class="flex items-center gap-0.5">
      <button
        onclick={autoCut}
        disabled={busy}
        class="grid h-7 w-7 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-40"
        title="AI suggestions — auto-cut silences longer than 3 s"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
        >
          <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
          <path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z" />
        </svg>
      </button>
      <button
        onclick={doSplit}
        class="grid h-7 w-7 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
        title="Split at playhead (S)"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
        >
          <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
          <path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" />
        </svg>
      </button>
      <button
        onclick={() => {
          project.snap = !project.snap;
          player.snap = project.snap;
        }}
        class="grid h-7 w-7 place-items-center rounded-md transition-colors
               {project.snap
          ? 'text-nc-brand hover:bg-nc-panel-2'
          : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
        title="Snap to line boundaries"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
        >
          <path d="M6 3v7a6 6 0 0 0 12 0V3M6 3H3M18 3h3M9 21h6" />
        </svg>
      </button>
    </div>

    <!-- centred transport -->
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div class="pointer-events-auto flex items-center gap-1.5">
        <button
          onclick={() => player.seek(0)}
          class="grid h-7 w-7 place-items-center rounded-full text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
          title="Go to start"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 5h2v14H6zM20 5L9 12l11 7z" />
          </svg>
        </button>
        <button
          onclick={() => player.seek(project.skipBy(player.currentTime, -settings.seekStepSec))}
          class="grid h-7 w-7 place-items-center rounded-full text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
          title="Back {settings.seekStepLabel}s (J)"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <path d="M11 17l-5-5 5-5" /><path d="M18 17l-5-5 5-5" />
            <text
              x="12"
              y="21"
              font-size={settings.seekStepLabel.length > 1 ? 6 : 7}
              fill="currentColor"
              text-anchor="middle">{settings.seekStepLabel}</text
            >
          </svg>
        </button>
        <button
          onclick={() => player.seek(project.skipBy(player.currentTime, settings.seekStepSec))}
          class="grid h-7 w-7 place-items-center rounded-full text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
          title="Forward {settings.seekStepLabel}s (L)"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <path d="M13 17l5-5-5-5" /><path d="M6 17l5-5-5-5" />
            <text
              x="12"
              y="21"
              font-size={settings.seekStepLabel.length > 1 ? 6 : 7}
              fill="currentColor"
              text-anchor="middle">{settings.seekStepLabel}</text
            >
          </svg>
        </button>
        <button
          onclick={() => player.toggle()}
          class="grid h-8 w-8 place-items-center rounded-full border border-nc-line-2 bg-nc-panel-2 text-nc-txt hover:bg-nc-line"
          title="Play / Pause (Space)"
        >
          {#if player.playing}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
            </svg>
          {:else}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          {/if}
        </button>
        <span class="ml-1 font-mono text-[12px] text-nc-txt">
          {fmtTime(player.currentTime)}
          <span class="text-nc-mut-2"> / {fmtTime(project.durationSec)}</span>
        </span>
      </div>
    </div>

    <div class="ml-auto flex items-center gap-1.5">
      <span class="flex items-center gap-1 text-[9px] text-nc-mut">
        <i class="inline-block h-1.5 w-1.5 rounded-sm bg-nc-brand"></i>keep
      </span>
      <span class="flex items-center gap-1 text-[9px] text-nc-mut">
        <i class="inline-block h-1.5 w-1.5 rounded-sm bg-nc-red"></i>fumble
      </span>
      <span class="flex items-center gap-1 text-[9px] text-nc-mut">
        <i class="inline-block h-1.5 w-1.5 rounded-sm bg-nc-mut-2"></i>khamoshi
      </span>
      <span class="mx-0.5 h-4 w-px bg-nc-line"></span>
      <button
        onclick={() => project.toggleTrackHidden('video')}
        class="flex h-6 items-center gap-1 rounded px-1.5 text-[9px] transition-colors
               {project.isTrackHidden('video')
          ? 'bg-nc-red/15 text-nc-red'
          : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
        title={project.isTrackHidden('video') ? 'Show video track' : 'Hide video track'}
      >
        <MenuIcon name={project.isTrackHidden('video') ? 'eyeOff' : 'eye'} size={12} />
        V
      </button>
      <button
        onclick={() => project.toggleTrackHidden('audio')}
        class="flex h-6 items-center gap-1 rounded px-1.5 text-[9px] transition-colors
               {project.isTrackHidden('audio')
          ? 'bg-nc-red/15 text-nc-red'
          : 'text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt'}"
        title={project.isTrackHidden('audio') ? 'Show audio track' : 'Hide audio track'}
      >
        <MenuIcon name={project.isTrackHidden('audio') ? 'eyeOff' : 'eye'} size={12} />
        A
      </button>
    </div>
  </div>

  {#if !layout.timelineCollapsed}
    <div
      bind:this={wrap}
      bind:clientWidth={viewW}
      onscroll={(e) => (scrollLeft = e.currentTarget.scrollLeft)}
      class="nc-scroll min-h-0 overflow-x-auto overflow-y-hidden"
    >
      <div class="relative" style="width:{contentW}px">
        <!-- SOURCE MINIMAP — the whole original, red where it was cut -->
        <div class="relative border-b border-nc-line/60" style="height:{MINIMAP_H}px">
          <canvas bind:this={miniCanvas} class="block" style="height:{MINIMAP_H}px"></canvas>
          <span
            class="pointer-events-none absolute left-1 top-0 text-[7px] leading-[7px] tracking-wider text-nc-mut-2/70"
            >SOURCE</span
          >
        </div>

        <!-- ruler (edit time) -->
        <div
          {...aria}
          class="relative cursor-pointer border-b border-nc-line"
          style="height:{RULER_H}px"
          onclick={onLaneClick}
          onkeydown={laneKeys}
        >
          {#each ticks as tick (tick.t)}
            <div
              class="absolute top-0 bottom-0 w-px {tick.major ? 'bg-nc-line-2' : 'bg-nc-line'}"
              style="left:{tick.t * zoom}px"
            ></div>
            {#if tick.major}
              <span
                class="absolute top-0.5 font-mono text-[9px] text-nc-mut"
                style="left:{tick.t * zoom + 3}px">{fmtShort(tick.t)}</span
              >
            {/if}
          {/each}
        </div>

        <!-- VIDEO lane · draggable clips on the edit timeline -->
        <div
          bind:this={laneEl}
          {...aria}
          class="relative cursor-pointer border-b border-nc-line/60 bg-nc-bg"
          style="height:{VIDEO_H}px"
          onclick={onLaneClick}
          onkeydown={laneKeys}
          title="Drag a clip to reorder the final video — the transcript follows"
        >
          <canvas bind:this={filmCanvas} class="absolute inset-0 block"></canvas>

          {#each segments as s (s.id)}
            {@const off = offsets.get(s.id)}
            {#if off}
              {@const sel = segmentSelection(s)}
              {@const tr = trim?.segId === s.id ? trim : null}
              {@const trStart = tr?.edge === 'start' ? tr.targetSec - s.startSec : 0}
              {@const trEnd = tr?.edge === 'end' ? tr.targetSec - s.endSec : 0}
              {@const left = off.start * zoom + trStart * zoom + (dragId === s.id ? dragDx : 0)}
              {@const width = Math.max(6, (off.end - off.start + trEnd - trStart) * zoom)}
              <div
                onpointerdown={(e) => onClipDown(e, s)}
                oncontextmenu={(e) => openClipMenu(e, s)}
                ondblclick={(e) => {
                  e.stopPropagation();
                  player.seek(s.startSec);
                }}
                onclick={(e) => e.stopPropagation()}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectSegment(s, e);
                  }
                }}
                role="button"
                tabindex="0"
                aria-pressed={sel === 'all'}
                aria-label="Clip {fmtShort(s.startSec)} to {fmtShort(s.endSec)} — drag to reorder"
                class="group absolute top-0 bottom-0 cursor-grab overflow-hidden rounded-[4px] border-2 transition-all active:cursor-grabbing
                       {dragId === s.id
                  ? 'z-20 border-nc-brand shadow-lg shadow-nc-brand/20'
                  : sel === 'all'
                    ? 'border-nc-brand ring-1 ring-nc-brand/40'
                    : sel === 'some'
                      ? 'border-dashed border-nc-brand/80'
                      : 'border-white/15 hover:border-nc-brand/70'}"
                style="left:{left}px;width:{width}px"
              >
                <!-- scrims so the filename and duration stay readable over any frame -->
                <div
                  class="pointer-events-none absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-black/70 to-transparent"
                ></div>
                <div
                  class="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-black/80 to-transparent"
                ></div>
                <span
                  class="pointer-events-none absolute top-0.5 left-1.5 max-w-[calc(100%-1.5rem)] truncate text-[9px] font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,.9)]"
                  >{project.media?.name ?? 'clip'}</span
                >
                <span
                  class="pointer-events-none absolute bottom-0.5 left-1.5 max-w-[calc(100%-2rem)] truncate font-mono text-[9px] text-white/85 drop-shadow-[0_1px_2px_rgba(0,0,0,.9)]"
                  >{fmtShort(s.startSec)}–{fmtShort(s.endSec)}</span
                >
                <button
                  onpointerdown={(e) => e.stopPropagation()}
                  onclick={(e) => {
                    e.stopPropagation();
                    project.toggleSegmentMute(s.id);
                    toast.push(
                      'info',
                      project.isSegmentMuted(s.id) ? 'Clip audio muted' : 'Clip audio unmuted'
                    );
                  }}
                  class="absolute right-1 bottom-0.5 z-20 grid h-4 w-4 place-items-center rounded bg-black/50 text-white/85 transition-opacity hover:bg-black/80 hover:text-white
                         {project.isSegmentMuted(s.id)
                    ? 'text-nc-red opacity-100'
                    : 'opacity-0 group-hover:opacity-100'}"
                  title={project.isSegmentMuted(s.id) ? 'Unmute clip audio' : 'Mute clip audio'}
                >
                  <MenuIcon
                    name={project.isSegmentMuted(s.id) ? 'volumeOff' : 'volume'}
                    size={11}
                  />
                </button>
                <div
                  onpointerdown={(e) => onTrimDown(e, s, 'start')}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Trim clip start"
                  class="absolute inset-y-0 left-0 z-20 w-[7px] cursor-ew-resize opacity-0 group-hover:opacity-100 {sel ===
                  'all'
                    ? 'opacity-100'
                    : ''}"
                  title="Trim clip start"
                >
                  <span
                    class="absolute inset-y-1 left-0 w-[2px] rounded bg-nc-brand shadow-[0_0_4px_rgba(0,0,0,.8)]"
                  ></span>
                </div>
                <div
                  onpointerdown={(e) => onTrimDown(e, s, 'end')}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Trim clip end"
                  class="absolute inset-y-0 right-0 z-20 w-[7px] cursor-ew-resize opacity-0 group-hover:opacity-100 {sel ===
                  'all'
                    ? 'opacity-100'
                    : ''}"
                  title="Trim clip end"
                >
                  <span
                    class="absolute inset-y-1 right-0 w-[2px] rounded bg-nc-brand shadow-[0_0_4px_rgba(0,0,0,.8)]"
                  ></span>
                </div>
                {#if tr}
                  <span
                    class="pointer-events-none absolute top-0.5 left-1/2 -translate-x-1/2 rounded bg-black/85 px-1 py-0.5 font-mono text-[9px] text-white"
                    >{fmtShort(tr.targetSec)}</span
                  >
                {/if}
              </div>
            {/if}
          {/each}

          {#if project.isTrackHidden('video')}
            <span
              class="pointer-events-none absolute top-1 right-1 z-10 rounded bg-nc-red/80 px-1.5 py-0.5 text-[8px] font-bold tracking-wider text-white"
              >VIDEO HIDDEN</span
            >
          {/if}

          {#if segments.length === 0}
            <div class="pointer-events-none absolute inset-0 z-10 grid place-items-center">
              <div
                class="pointer-events-auto flex items-center gap-2 rounded-md border border-nc-line-2 bg-nc-panel/95 px-3 py-1.5 text-[11px] text-nc-mut shadow-lg"
              >
                <span>{project.lines.length ? 'Saare clips cut ho gaye' : 'Koi clip nahi'}</span>
                {#if project.past.length}
                  <button
                    onclick={(e) => {
                      e.stopPropagation();
                      project.undo();
                    }}
                    class="rounded border border-nc-line-2 px-2 py-0.5 text-[10px] text-nc-txt hover:border-nc-brand/60 hover:text-nc-brand"
                    >Undo</button
                  >
                {/if}
              </div>
            </div>
          {/if}
        </div>

        <!-- AUDIO lane -->
        <div
          {...aria}
          class="relative cursor-pointer bg-nc-panel"
          style="height:{AUDIO_H}px"
          onclick={onLaneClick}
          onkeydown={laneKeys}
          title="Source audio — muted clips are ghosted"
        >
          <canvas
            bind:this={waveCanvas}
            class="block {project.isTrackHidden('audio') ? 'opacity-40' : ''}"
            style="height:{AUDIO_H}px"
          ></canvas>
          <span
            class="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-[11px] text-nc-mut"
            >♪</span
          >
          {#if project.isTrackHidden('audio')}
            <span
              class="pointer-events-none absolute top-1 right-1 rounded bg-nc-red/80 px-1.5 py-0.5 text-[8px] font-bold tracking-wider text-white"
              >AUDIO HIDDEN</span
            >
          {/if}
        </div>

        <!-- playhead -->
        {#if editPlayhead != null}
          <div
            role="slider"
            tabindex="0"
            aria-label="Playhead"
            aria-orientation="horizontal"
            aria-valuemin="0"
            aria-valuemax={Math.round(editDur)}
            aria-valuenow={Math.round(editPlayhead ?? 0)}
            class="absolute top-0 bottom-0 z-30 w-[10px] -translate-x-1/2 cursor-ew-resize"
            style="left:{editPlayhead * zoom}px"
            onpointerdown={onPlayheadDown}
            title="Drag playhead"
          >
            <div class="mx-auto h-full w-[2px] bg-nc-txt"></div>
          </div>
          <div
            role="slider"
            tabindex="0"
            aria-label="Playhead"
            aria-orientation="horizontal"
            aria-valuemin="0"
            aria-valuemax={Math.round(editDur)}
            aria-valuenow={Math.round(editPlayhead ?? 0)}
            class="absolute z-40 h-3.5 w-3.5 -translate-x-1/2 cursor-ew-resize rounded-full border border-black/30 bg-nc-txt shadow-lg"
            style="left:{editPlayhead * zoom}px;top:{MINIMAP_H + RULER_H - 14}px"
            onpointerdown={onPlayheadDown}
            title="Drag playhead"
          ></div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- floating bottom-right toolbar (Clipchamp's `fui-Toolbar`, 129.6 × 33.2) -->
  <div
    class="absolute right-3 bottom-2 z-20 flex items-center gap-0.5 rounded-lg border border-nc-line bg-nc-panel-2/95 p-0.5 backdrop-blur-sm"
  >
    <button
      onclick={() => nudgeZoom(-1)}
      class="grid h-7 w-7 place-items-center rounded text-nc-mut hover:bg-nc-line hover:text-nc-txt"
      title="Zoom out"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
      >
        <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4M8 11h6" />
      </svg>
    </button>
    <button
      onclick={() => nudgeZoom(1)}
      class="grid h-7 w-7 place-items-center rounded text-nc-mut hover:bg-nc-line hover:text-nc-txt"
      title="Zoom in"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.9"
      >
        <circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4M11 8v6M8 11h6" />
      </svg>
    </button>
    <button
      onclick={zoomFit}
      class="grid h-7 w-7 place-items-center rounded text-nc-mut hover:bg-nc-line hover:text-nc-txt"
      title="Zoom to fit"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      >
        <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
      </svg>
    </button>
    <span class="mx-0.5 h-4 w-px bg-nc-line"></span>
    <button
      onclick={() => (layout.timelineCollapsed = !layout.timelineCollapsed)}
      class="grid h-7 w-7 place-items-center rounded text-nc-mut hover:bg-nc-line hover:text-nc-txt"
      title="Collapse timeline"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        class="transition-transform {layout.timelineCollapsed ? 'rotate-180' : ''}"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  </div>

  {#if ctx}
    <ContextMenu
      items={clipMenuItems}
      x={ctx.x}
      y={ctx.y}
      onchoose={onMenuChoose}
      onclose={() => (ctx = null)}
    />
  {/if}
</section>
