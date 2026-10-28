<script lang="ts">
  import { project, isAudioOnly } from '../../stores/project.svelte';
  import { media } from '../../stores/media.svelte';
  import { player } from '../../stores/player.svelte';
  import { layout } from '../../stores/layout.svelte';
  import { settings } from '../../stores/settings.svelte';
  import { toast } from '../../stores/toast.svelte';
  import { thumbUrl } from '../../media';
  import { dropIndex, moveInOrder } from '../../segments';
  import { clamp, fmtShort, fmtTime, niceStep } from '../../utils';
  import ContextMenu from '../ContextMenu.svelte';
  import MenuIcon from '../MenuIcon.svelte';
  import ClipFilmstrip from './ClipFilmstrip.svelte';
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
  /** True while a library tile is dragged over the video lane. */
  let dropHover = $state(false);

  /* ---- clip drag state ---- */
  let dragId: string | null = $state(null);
  let dragDx = $state(0);
  /** While a clip is dragged: the slot it would land in (index among the
   *  other segments). Painted as a blue caret so the drop is never a guess. */
  let dropSlot = $state<number | null>(null);
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
  /** The timeline is the EDIT timeline: the main cut, then every extra clip. */
  const editDur = $derived(project.sequenceDuration || project.durationSec);
  /** Extra clips, with where each one starts on the timeline. */
  const extras = $derived(project.extrasLayout);
  /** Playhead on the whole project timeline (main cut + extras). */
  const editPlayhead = $derived(project.globalTimeAt(project.activeClipId, player.currentTime));
  const contentW = $derived(Math.max(600, viewW, (editDur + 4) * zoom));
  const step = $derived(niceStep(zoom));
  /** Four intervals per label gap = three dots between labels, like Clipchamp. */
  const minor = $derived(step / 4);

  const ticks = $derived.by(() => {
    const out: Array<{ t: number; major: boolean }> = [];
    for (let t = 0; t <= editDur + 0.001 && out.length < 3000; t += minor) {
      out.push({ t, major: Math.abs(t / step - Math.round(t / step)) < 1e-6 });
    }
    return out;
  });

  const segments = $derived(project.orderedSegments);
  const offsets = $derived(project.segmentOffsets);

  /** Where the blue drop caret sits while a clip is in the air, in px. */
  const dropSlotX = $derived.by(() => {
    if (!dragId || dropSlot == null) return null;
    const others = segments.filter((s) => s.id !== dragId);
    if (!others.length) return 0;
    const at = Math.min(Math.max(0, dropSlot), others.length);
    if (at >= others.length) {
      const off = offsets.get(others[others.length - 1].id);
      return off ? off.end * zoom : null;
    }
    const off = offsets.get(others[at].id);
    return off ? off.start * zoom : null;
  });

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

  /** The source minimap: the whole original video, drawn at the width the
   *  lanes actually scroll (contentW, zoom-synced). The scale used to be a
   *  hard-coded 2 px/sec — a 22000-px timeline got a 400-px strip, so every
   *  cut past the first ~300 s was invisible: "kuch bhi hide ho gaya". */
  function drawMinimap() {
    const c = miniCanvas;
    if (!c) return;
    const w = contentW;
    c.width = w;
    c.height = MINIMAP_H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dur = project.durationSec || 1;
    const scale = w / dur;
    ctx.fillStyle = '#1a1c26';
    ctx.fillRect(0, 0, w, MINIMAP_H);
    // AI suggestions first — a staged span paints GREEN and disappears the
    // moment either side of the deal changes (applied, rejected, or the user
    // cut the span manually). Red is painted after, so an already-cut region
    // always reads as its final state.
    ctx.fillStyle = 'rgba(61, 214, 140, 0.8)';
    for (const r of project.liveSuggestions) {
      ctx.fillRect(r.start * scale, 0, Math.max(1, (r.end - r.start) * scale), MINIMAP_H);
    }
    // Text-level suggestions get their own colour: a fumble or a retake is a
    // different kind of evidence from a silent gap, and the user must be able
    // to tell which is which before pressing Apply.
    ctx.fillStyle = 'rgba(245, 158, 11, 0.85)';
    for (const s of project.liveQualitySuggestions) {
      ctx.fillRect(s.startSec * scale, 0, Math.max(1, (s.endSec - s.startSec) * scale), MINIMAP_H);
    }
    ctx.fillStyle = 'rgba(229, 72, 77, 0.75)';
    for (const l of project.lines) {
      if (l.keep === 'keep') continue;
      ctx.fillRect(l.startSec * scale, 0, Math.max(1, (l.endSec - l.startSec) * scale), MINIMAP_H);
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
    void project.suggestions; // green preview repaints the moment it changes
    void project.qualitySuggestions; // and so does the amber one
    void project.durationSec; // and when the loaded source length changes
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
  /**
   * Jump the playhead to a bottom-timeline position, whichever clip owns it.
   *
   * The main cut owns everything before `editDuration`; after it, the extra
   * clips play back-to-back. Activating the target clip first means the
   * preview has the right `<video src>` before it seeks.
   */
  function seekToEdit(editSec: number, snap = true) {
    const at = project.sequenceAt(editSec);
    if (!at) return;
    const local = snap && !at.clip ? project.snapTime(at.localSec) : at.localSec;
    project.activateClip(at.clip?.id ?? null);
    player.seek(local);
  }

  /** Transport start: the active clip's in-point (the project start for main). */
  function goStart() {
    const clip = project.activeClip;
    player.seek(clip ? clip.inSec : 0);
  }

  /**
   * Step the playhead. On the main cut this skips over cut ranges; inside an
   * extra clip it is a plain step clamped to the clip's own in/out points -
   * that clip has no transcript, so there is nothing to skip.
   */
  function stepBy(delta: number) {
    const clip = project.activeClip;
    if (!clip) {
      player.seek(project.skipBy(player.currentTime, delta));
      return;
    }
    const next = player.currentTime + delta;
    player.seek(Math.min(clip.outSec, Math.max(clip.inSec, next)));
  }

  function seekFromEvent(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const editSec = clamp((e.clientX - rect.left) / zoom, 0, editDur);
    seekToEdit(editSec);
  }

  /**
   * Drop a library tile on the timeline.
   *
   * This is the Clipchamp gesture: drag from My media, drop on the bottom
   * timeline, and the asset becomes a clip. The project's main cut is only
   * replaced when there is no main source yet - then the dropped file becomes
   * the project's source, exactly like the tile's + button.
   */
  async function onLaneDrop(e: DragEvent) {
    dropHover = false;
    const id = e.dataTransfer?.getData('application/x-t9-asset');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const entry = media.get(id);
    if (!entry) return;
    if (isAudioOnly(entry.asset.name, entry.asset.url)) {
      toast.push('info', 'Audio-only clip abhi timeline me nahi lagta');
      return;
    }
    // Dropping the project's own source on its timeline is not an error - it
    // is already there. Say that, instead of the generic "nahi lag sakta"
    // red toast the tile's + button never showed. `inUse` is the library's
    // stable marker for "this is the open project"; path equality missed
    // when the URL had been normalised.
    if (
      entry.inUse ||
      (project.media &&
        (entry.path ? entry.path === project.sourcePath : entry.asset.url === project.media.url))
    ) {
      toast.push('info', 'Yeh clip project ka main source hai — timeline par already hai');
      return;
    }
    const placed = await project.placeAsset(id);
    if (placed === 'source') {
      toast.push('info', `${entry.asset.name} project ka main video ban gaya`);
    } else if (placed === 'clip') {
      toast.push('info', `+ ${entry.asset.name} timeline me add ho gaya`);
    } else {
      toast.push('warn', 'Yeh asset timeline me nahi lag sakta');
    }
  }

  function dragHasAsset(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    return !!types && Array.from(types).includes('application/x-t9-asset');
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
    'aria-valuenow': Math.round(editPlayhead)
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

  /** Clipchamp's "AI suggestions" — find long silences **and** the transcript
   *  lines that are a fumble or a second take, and stage both as a preview.
   *  Nothing is cut until the user presses Apply beside the legend: a
   *  suggestion must be SEEN before it can take clips away.
   *
   *  The waveform alone is not enough — an `umm` false start or a retake has
   *  no silence in it at all, so `suggestQuality()` reads the words too. */
  async function autoSuggest() {
    if (busy) return;
    busy = true;
    toast.push('info', 'AI: scanning silences + transcript…');
    try {
      const silences = await project.suggestSilences(3.0);
      const lines = project.suggestQuality();
      const parts: string[] = [];
      if (silences) parts.push(`${silences} silence`);
      if (lines) parts.push(`${lines} fumble/repeat`);
      toast.push(
        'info',
        parts.length
          ? `${parts.join(' + ')} suggestions — green silence, amber lines`
          : 'AI: na 3s+ silence mili, na koi fumble/repeat line'
      );
    } catch (e) {
      toast.push('warn', `AI scan failed: ${e instanceof Error ? e.message : e}`);
    }
    busy = false;
  }

  /** The staged preview becomes real cuts. */
  function applySuggestions() {
    const silences = project.applySuggestions();
    const lines = project.applyQualitySuggestions();
    const n = silences + lines;
    const what: string[] = [];
    if (silences) what.push(`${silences} silence`);
    if (lines) what.push(`${lines} fumble/repeat`);
    toast.push(
      n ? 'cut' : 'info',
      n ? `✕ ${what.join(' + ')} cut` : 'Koi suggestion apply nahi hui'
    );
  }

  /** Throw the staged preview away without touching anything. */
  function rejectSuggestions() {
    project.clearSuggestions();
    project.clearQualitySuggestions();
    toast.push('info', 'Suggestions hata di — kuch cut nahi hua');
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
    let lastX = startX;
    let autoScroll = 0;
    let frame = 0;

    /** The slot the pointer is over, as an index among the *other* segments. */
    const slotAt = (clientX: number, rect: DOMRect) => {
      const editSec = clamp((clientX - rect.left) / zoom, 0, editDur);
      return dropIndex(segments, offsets, seg.id, editSec);
    };

    /** Paint (and keep painting) the caret where the clip would land. */
    const refresh = () => {
      if (!laneEl) return;
      dropSlot = slotAt(lastX, laneEl.getBoundingClientRect());
    };

    const scrollStep = () => {
      frame = 0;
      if (!autoScroll || !laneEl) return;
      laneEl.scrollLeft += autoScroll;
      refresh();
      frame = requestAnimationFrame(scrollStep);
    };

    const move = (ev: PointerEvent) => {
      lastX = ev.clientX;
      dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      dragId = seg.id;
      dragDx = dx;
      if (!laneEl) return;
      const rect = laneEl.getBoundingClientRect();
      refresh();
      // Carry the clip past the visible window: near an edge, scroll.
      const edge = 48;
      autoScroll = lastX < rect.left + edge ? -16 : lastX > rect.right - edge ? 16 : 0;
      if (autoScroll && !frame) frame = requestAnimationFrame(scrollStep);
      if (!autoScroll && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      const id = dragId;
      const target = dropSlot;
      dragId = null;
      dragDx = 0;
      dropSlot = null;
      if (!moved) {
        // A plain click selects and reveals the clip's first frame.
        player.seek(seg.startSec);
        return;
      }
      if (!id || target == null) return;

      // Compare the *result* of the move, not two different index spaces:
      // a drop that changes nothing used to look like a broken drag.
      const order = segments.map((s) => s.id);
      const next = moveInOrder(order, id, target);
      if (next.join() !== order.join()) {
        project.moveSegment(id, target);
        toast.push('info', 'Clip moved — transcript reordered');
      } else {
        toast.push('info', 'Clip wahi jagah hai — aur door kheenchiye');
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
      seekToEdit(editSec);
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
    // A cut block is not editable material — it stays on the timeline as red
    // (or grey) evidence of what went, and its only action is coming back.
    if (seg.state === 'cut') {
      return [
        {
          id: 'restore',
          label:
            seg.reason === 'silence' ? 'Restore silence (grey block)' : 'Restore clip (red block)',
          icon: 'split'
        }
      ];
    }
    const inside =
      player.currentTime > seg.startSec + 0.15 && player.currentTime < seg.endSec - 0.15;
    const muted = project.isSegmentMuted(seg.id);
    const gain = project.segmentGain(seg.id);
    const vol = (v: number, label: string): MenuItem => ({
      id: `vol-${v}`,
      // A dot marks the current value: the menu has no checkbox column.
      label: `${Math.abs(gain - v) < 0.005 ? '● ' : ''}Volume ${label}`,
      icon: 'volume'
    });
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
      // The sketch asks for volume as well as mute, because every clip is its
      // own strip (docs/TIMELINE_HUMAN_DIAGRAM.md §1.2).
      { ...vol(1, '100%'), secondary: 'Preview and export both follow this' },
      vol(0.75, '75%'),
      vol(0.5, '50%'),
      vol(0.25, '25%'),
      { id: 'div-2', label: '', divider: true },
      // Cut, not delete: the block turns red and stays where it is.
      { id: 'delete', label: 'Cut clip (block stays on timeline)', icon: 'scissors', danger: true }
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
    } else if (id.startsWith('vol-')) {
      const gain = Number(id.slice(4));
      project.setSegmentVolume(seg.id, gain);
      toast.push('info', `Clip volume ${Math.round(project.segmentGain(seg.id) * 100)}%`);
    } else if (id === 'delete') {
      project.cutSegments([seg.id]);
      toast.push('cut', '✂ Clip cut — red block timeline par pada hai');
    } else if (id === 'restore') {
      if (project.restoreSegments([seg.id]))
        toast.push('info', 'Clip restored — wapas timeline par');
    }
  }

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
        onclick={autoSuggest}
        disabled={busy}
        class="grid h-7 w-7 place-items-center rounded-md text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt disabled:opacity-40"
        title="AI suggestions — silences ≥ 3s + fumble/repeat lines; green/amber preview, Apply se cut hote hain"
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
          player.previewRaw = !player.previewRaw;
          toast.push(
            'info',
            player.previewRaw
              ? '◉ Raw preview — cut material bhi play hoga'
              : '✂ Applied preview — cuts skip ho rahe hain'
          );
        }}
        class="grid h-7 w-7 place-items-center rounded-md transition-colors
               {player.previewRaw
          ? 'text-amber-400 hover:bg-nc-panel-2'
          : 'text-nc-brand hover:bg-nc-panel-2'}"
        aria-pressed={player.previewRaw}
        title={player.previewRaw
          ? 'Raw preview ON — playback cut material ko bhi dikhata hai (click: applied mode)'
          : 'Applied preview — playback cuts skip karta hai (click: raw mode, cut material dekho)'}
      >
        <!-- The play button, cut in two: applied mode holds the halves apart
             with a dashed cut line between them; raw mode closes the gap and
             the triangle becomes whole again. -->
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M6 4L12 7.7V16.3L6 20Z"
            fill="currentColor"
            stroke="none"
            class="transition-transform duration-300 ease-out {player.previewRaw
              ? ''
              : '-translate-x-[1.5px]'}"
          />
          <path
            d="M12 7.7L19 12L12 16.3Z"
            fill="currentColor"
            stroke="none"
            class="transition-transform duration-300 ease-out {player.previewRaw
              ? ''
              : 'translate-x-[1.5px]'}"
          />
          <path
            d="M12 3.5V20.5"
            stroke-dasharray="2 2.5"
            class="transition-opacity duration-300 {player.previewRaw
              ? 'opacity-0'
              : 'opacity-100'}"
          />
        </svg>
      </button>
    </div>

    <!-- centred transport -->
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div class="pointer-events-auto flex items-center gap-1.5">
        <button
          onclick={goStart}
          class="grid h-7 w-7 place-items-center rounded-full text-nc-mut hover:bg-nc-panel-2 hover:text-nc-txt"
          title="Go to start"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 5h2v14H6zM20 5L9 12l11 7z" />
          </svg>
        </button>
        <button
          onclick={() => stepBy(-settings.seekStepSec)}
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
          onclick={() => stepBy(settings.seekStepSec)}
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
          {fmtTime(editPlayhead)}
          <span class="text-nc-mut-2"> / {fmtTime(project.sequenceDuration)}</span>
        </span>
      </div>
    </div>

    <div class="ml-auto flex items-center gap-1.5">
      {#if project.liveSuggestions.length || project.liveQualitySuggestions.length}
        <div
          class="flex items-center gap-1 rounded-md border px-1.5 py-0.5
                 {project.liveQualitySuggestions.length && !project.liveSuggestions.length
            ? 'border-amber-400/40 bg-amber-400/10'
            : 'border-nc-green/40 bg-nc-green/10'}"
          title={project.liveQualitySuggestions
            .slice(0, 4)
            .map((s) => s.reason)
            .join(' · ')}
        >
          {#if project.liveSuggestions.length}
            <span class="text-[9px] font-medium text-nc-green">
              {project.liveSuggestions.length} silence
            </span>
          {/if}
          {#if project.liveQualitySuggestions.length}
            <span class="text-[9px] font-medium text-amber-300">
              {project.liveQualitySuggestions.length} line{project.liveQualitySuggestions.length ===
              1
                ? ''
                : 's'}
            </span>
          {/if}
          <button
            onclick={applySuggestions}
            class="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-bold text-nc-txt transition-colors hover:bg-white/20"
            title="Apply — staged spans ban jaate hain red cuts"
          >
            Apply
          </button>
          <button
            onclick={rejectSuggestions}
            class="rounded px-1 text-[9px] text-nc-mut transition-colors hover:text-nc-txt"
            title="Reject — timeline untouched"
          >
            ✕
          </button>
        </div>
        <span class="mx-0.5 h-4 w-px bg-nc-line"></span>
      {/if}
      <span class="flex items-center gap-1 text-[9px] text-nc-mut">
        <i class="inline-block h-1.5 w-1.5 rounded-sm bg-nc-brand"></i>keep
      </span>
      <span class="flex items-center gap-1 text-[9px] text-nc-mut">
        <i class="inline-block h-1.5 w-1.5 rounded-sm bg-nc-red"></i>fumble
      </span>
      <span class="flex items-center gap-1 text-[9px] text-nc-mut">
        <i class="inline-block h-1.5 w-1.5 rounded-sm bg-nc-mut-2"></i>khamoshi
      </span>
      <span class="flex items-center gap-1 text-[9px] text-nc-mut">
        <i class="inline-block h-1.5 w-1.5 rounded-sm bg-nc-green"></i>suggest
      </span>
      <span class="flex items-center gap-1 text-[9px] text-nc-mut">
        <i class="inline-block h-1.5 w-1.5 rounded-sm bg-amber-400"></i>AI fumble
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
        <!-- SOURCE MINIMAP — the whole original, green = AI suggestion,
             red = cut. Stretched across the scroll width so nothing hides. -->
        <div class="relative border-b border-nc-line/60" style="height:{MINIMAP_H}px">
          <canvas
            bind:this={miniCanvas}
            class="block"
            style="width:{contentW}px;height:{MINIMAP_H}px"
          ></canvas>
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
            {#if tick.major}
              <span
                class="absolute top-0.5 font-mono text-[9px] text-nc-mut"
                style="left:{tick.t * zoom + 3}px">{fmtShort(tick.t)}</span
              >
            {:else}
              <!-- Clipchamp's ruler carries no hairlines: between two labels
                   sit small dots (three per label gap), on the labels' own
                   line. A full-height `w-px` line per tick read as a fence
                   over the lane below; a 3px dot reads as a ruler. -->
              <span
                class="absolute top-[7px] h-[3px] w-[3px] rounded-full bg-nc-mut-2/70"
                style="left:{tick.t * zoom}px"
              ></span>
            {/if}
          {/each}
        </div>

        <!-- VIDEO lane · draggable clips on the edit timeline -->
        <div
          bind:this={laneEl}
          {...aria}
          class="relative cursor-pointer border-b border-nc-line/60 bg-nc-bg {dropHover
            ? 'ring-2 ring-inset ring-nc-brand/70'
            : ''}"
          style="height:{VIDEO_H}px"
          onclick={onLaneClick}
          onkeydown={laneKeys}
          ondragover={(e) => {
            if (!dragHasAsset(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            dropHover = true;
          }}
          ondragleave={() => (dropHover = false)}
          ondrop={onLaneDrop}
          data-t9-drop="lane"
          title="Drag a clip to reorder the final video — the transcript follows"
        >
          <canvas bind:this={filmCanvas} class="absolute inset-0 block"></canvas>

          {#each segments as s (s.id)}
            {@const off = offsets.get(s.id)}
            {#if off}
              {@const sel = segmentSelection(s)}
              {@const cut = s.state === 'cut'}
              {@const silence = cut && s.reason === 'silence'}
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
                aria-label="Clip {fmtShort(s.startSec)} to {fmtShort(s.endSec)}{cut
                  ? ` — ${silence ? 'silence' : 'cut'} block, right-click to restore`
                  : ' — drag to reorder'}"
                title={cut
                  ? `${silence ? 'Silence' : 'Cut'} ${fmtShort(s.startSec)}–${fmtShort(s.endSec)} · ${fmtShort(s.endSec - s.startSec)} — right-click to restore`
                  : undefined}
                class="group absolute top-0 bottom-0 cursor-grab overflow-hidden rounded-[4px] border-2 transition-all active:cursor-grabbing
                       {dragId === s.id ? 'transition-none' : ''}
                       {dragId === s.id
                  ? 'z-20 border-nc-brand shadow-lg shadow-nc-brand/20'
                  : cut
                    ? silence
                      ? 'border-white/20 bg-nc-panel brightness-[.45] saturate-0'
                      : 'border-nc-red/70 bg-nc-red/25 brightness-[.6]'
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
                  >{fmtShort(s.startSec)}–{fmtShort(s.endSec)} · {fmtShort(
                    s.endSec - s.startSec
                  )}</span
                >
                {#if cut}
                  <span
                    class="pointer-events-none absolute top-0.5 right-1.5 z-10 rounded px-1 text-[8px] font-bold tracking-wider {silence
                      ? 'bg-white/20 text-white/80'
                      : 'bg-nc-red/85 text-white'}">{silence ? 'SILENCE' : 'CUT'}</span
                  >
                {:else if project.segmentGain(s.id) !== 1}
                  <span
                    class="pointer-events-none absolute right-6 bottom-0.5 z-20 rounded bg-black/55 px-1 font-mono text-[8px] leading-4 text-white/85"
                    title="Clip volume — right-click the clip to change"
                    >{Math.round(project.segmentGain(s.id) * 100)}%</span
                  >
                {/if}
                {#if !cut}
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
                {/if}
                {#if !cut}
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
                {/if}
                {#if tr}
                  <span
                    class="pointer-events-none absolute top-0.5 left-1/2 -translate-x-1/2 rounded bg-black/85 px-1 py-0.5 font-mono text-[9px] text-white"
                    >{fmtShort(tr.targetSec)}</span
                  >
                {/if}
              </div>
            {/if}
          {/each}

          <!-- Extra clips: assets added from My media, appended after the cut. -->
          {#each extras as r (r.clip.id)}
            {@const active = project.activeClipId === r.clip.id}
            <div
              role="button"
              tabindex="0"
              aria-label="{r.clip.name} — click to preview"
              aria-pressed={active}
              class="group absolute top-0 bottom-0 z-10 overflow-hidden rounded-[4px] border-2 transition-all
                     {active
                ? 'border-nc-brand ring-1 ring-nc-brand/40'
                : 'border-white/15 hover:border-nc-brand/70'}"
              style="left:{r.start * zoom}px;width:{Math.max(6, (r.end - r.start) * zoom)}px"
              onpointerdown={(e) => e.stopPropagation()}
              onclick={(e) => {
                e.stopPropagation();
                project.activateClip(r.clip.id);
              }}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  project.activateClip(r.clip.id);
                }
              }}
            >
              <div
                class="absolute inset-0 bg-gradient-to-br from-nc-brand/25 via-nc-panel-2 to-black/40"
              ></div>
              <!-- The sketch asks for a dropped clip to look "like previews":
                   real frames, not a gradient. The strip falls back to the
                   gradient above if the file cannot be read. -->
              <ClipFilmstrip
                src={r.clip.url}
                kind={r.clip.kind}
                inSec={r.clip.inSec}
                outSec={r.clip.outSec}
                width={Math.max(6, (r.end - r.start) * zoom)}
              />
              <div
                class="pointer-events-none absolute inset-0 bg-gradient-to-br from-nc-brand/10 via-transparent to-black/35"
              ></div>
              <div
                class="pointer-events-none absolute inset-x-0 top-0 h-5 bg-gradient-to-b from-black/70 to-transparent"
              ></div>
              <div
                class="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-black/80 to-transparent"
              ></div>
              <span
                class="pointer-events-none absolute top-0.5 left-1.5 max-w-[calc(100%-2.5rem)] truncate text-[9px] font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,.9)]"
                >{r.clip.name}</span
              >
              <span
                class="pointer-events-none absolute bottom-0.5 left-1.5 max-w-[calc(100%-2rem)] truncate font-mono text-[9px] text-white/85 drop-shadow-[0_1px_2px_rgba(0,0,0,.9)]"
                >{r.clip.kind === 'image' ? 'still' : fmtShort(r.clip.outSec - r.clip.inSec)}</span
              >
              <button
                onclick={(e) => {
                  e.stopPropagation();
                  project.removeClip(r.clip.id);
                  toast.push('cut', 'Clip timeline se hata diya');
                }}
                class="absolute top-0.5 right-0.5 z-20 grid h-4 w-4 place-items-center rounded bg-black/60 text-[10px] leading-none text-white/85 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-nc-red/50 hover:text-white hover:backdrop-blur-md"
                title="Remove from timeline"
                aria-label="Remove {r.clip.name} from timeline">×</button
              >
            </div>
          {/each}

          {#if dropSlotX != null}
            <!-- The drop caret: without it a drag gives no clue where the clip
                 will land, and a drop that changes nothing reads as broken. -->
            <div
              class="pointer-events-none absolute top-0 bottom-0 z-30 w-[2px] -translate-x-1/2 rounded bg-nc-brand shadow-[0_0_6px_rgba(77,141,255,.9)]"
              style="left:{dropSlotX}px"
            ></div>
          {/if}

          {#if project.isTrackHidden('video')}
            <span
              class="pointer-events-none absolute top-1 right-1 z-10 rounded bg-nc-red/40 px-1.5 py-0.5 text-[8px] font-bold tracking-wider text-white backdrop-blur-md"
              >VIDEO HIDDEN</span
            >
          {/if}

          {#if segments.length === 0 && extras.length === 0}
            <!-- Empty project = the Clipchamp drop target: a dashed lane that
                 says what to do, not a mysterious blank strip. -->
            <div
              class="pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-[4px] border-2 border-dashed transition-colors
                     {dropHover ? 'border-nc-brand/80 bg-nc-brand/10' : 'border-nc-line-2'}"
            >
              <div
                class="pointer-events-auto flex items-center gap-2 rounded-md bg-nc-panel/90 px-3 py-1 text-[11px] text-nc-mut"
              >
                {#if project.lines.length}
                  <span>Saare clips cut ho gaye</span>
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
                {:else}
                  <span class="font-semibold text-nc-txt">Drag &amp; drop media here</span>
                  <span class="text-nc-mut-2">· My media se clip kheencho ya + dabao</span>
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
              class="pointer-events-none absolute top-1 right-1 rounded bg-nc-red/40 px-1.5 py-0.5 text-[8px] font-bold tracking-wider text-white backdrop-blur-md"
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
