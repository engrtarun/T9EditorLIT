# ============================================================================
#  docs/timeline-logic/build.ps1
#  Builds docs/TIMELINE_UI_UX.ipynb - the timeline UI/UX + feature reference.
#
#  Why PowerShell and not nbformat? Python is banned repo-wide (AGENTS.md 2).
#  Run:  pwsh -File docs/timeline-logic/build.ps1
# ============================================================================

$ErrorActionPreference = 'Stop'

$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
$REPO = Resolve-Path (Join-Path $HERE '..\..')

function To-Source([string]$Text) {
  $clean = $Text -replace "`r`n", "`n"
  $lines = $clean -split "`n"
  $out = @()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($i -lt $lines.Count - 1) { $out += ($lines[$i] + "`n") }
    else { $out += $lines[$i] }
  }
  return $out
}

$cells = New-Object System.Collections.ArrayList

function Add-Markdown([string]$Text) {
  [void]$cells.Add(@{
      cell_type = 'markdown'
      metadata  = @{}
      source    = (To-Source $Text)
    })
}

function Add-Code([string]$Text) {
  [void]$cells.Add(@{
      cell_type       = 'code'
      execution_count = $null
      metadata        = @{}
      outputs         = @()
      source          = (To-Source $Text)
    })
}

# ---------------------------------------------------------------------------
# 1. Title
# ---------------------------------------------------------------------------
Add-Markdown @'
# T9 Editor LIT - Timeline UI/UX + Feature Map

**Component:** `Clipchamp_Bunny/src/lib/components/cut/WaveTimeline.svelte`
**Mode:** `CUT` (one of the zero-RAM modes; `{#key}` destroys the previous tree)
**Updated:** 21 Oct 2026
**Status:** the **text lane was removed**. The timeline is a cut / reorder
surface only - the user cannot create, move, trim or hide text here.

> Is notebook me timeline ka poora UI/UX, har feature, interaction recipe,
> data model, zero-RAM rendering, keyboard map, edge cases aur verification
> likha hai. Code cells asli source se liye gaye excerpts hain, taaki doc aur
> code kabhi diverge na hon.

## Contents

1. What the timeline is
2. Anatomy and exact pixel metrics
3. UI/UX principles and colour language
4. Full feature catalogue
5. Keyboard map
6. Data model - source axis vs edit axis
7. Interaction recipes
8. Zero-RAM rendering strategy
9. Accessibility and input
10. Empty, error and edge states
11. Text lane removal (current behaviour)
12. Verification
13. File map and known limits
14. Changelog
'@

# ---------------------------------------------------------------------------
# 2. What it is
# ---------------------------------------------------------------------------
Add-Markdown @'
## 1. What the timeline is

The bottom block is the **edit timeline**: the final video, gapless, exactly
what export will produce. It is **not** the source video with gaps. Cutting a
line in the transcript removes it from this axis; reordering a clip changes
the order of the final video immediately.

```text
source video (what is on disk)
 0 --- [ cut ] --- [ segment A ] --- [ cut ] --- [ segment B ] --- end

edit timeline (what the user sees and exports)
 0 ---------------- [ A ] ---------------------- [ B ] ---------- duration
                     ^ playhead lives here
```

Three consequences shape the whole design:

1. **Phantom Cut** - preview and export skip cut ranges; nothing is
   re-encoded just to preview a cut.
2. **One source of truth** - the transcript, the timeline clips and the preview
   all derive from `project.lines` + `project.segmentOrder`; there is no second
   copy to keep in sync.
3. **Gapless edit axis** - deleting a clip closes the gap automatically, so the
   user never has to ripple-delete by hand.

The timeline is deliberately **cut-focused**: video clips, audio, trim, mute,
reorder, silence auto-cut. Text overlays are not part of the app right now.
'@

# ---------------------------------------------------------------------------
# 3. Anatomy
# ---------------------------------------------------------------------------
Add-Markdown @'
## 2. Anatomy and exact pixel metrics

```text
+-----------------------------------------------------------------------+
| 3px resize strip            (drag up/down, double-click = 191)        |
+-----------------------------------------------------------------------+
| TOOL ROW 30px                                                         |
|   [AI silence] [split] [snap]      (transport, centred)   legend [V][A]|
+-----------------------------------------------------------------------+
| SOURCE MINIMAP 7px   the whole original, red where it was cut         |
+-----------------------------------------------------------------------+
| RULER 24px           0:00 -------- 0:30 -------- 1:00 ------          |
+-----------------------------------------------------------------------+
| VIDEO lane           [ clip ][ clip ][ clip ]   drag = reorder        |
|                      (flexible, 52/96 of the lane budget)             |
+-----------------------------------------------------------------------+
| AUDIO lane           waveform, gold/red/grey per source section       |
|                      (flexible, 44/96 of the lane budget)             |
+-----------------------------------------------------------------------+
| floating zoom / collapse toolbar, bottom-right                        |
+-----------------------------------------------------------------------+
```

| Part | Height | Notes |
| ---- | ------ | ----- |
| Resize strip | 3px | `cursor-row-resize`, double-click resets to 191px |
| Tool row | 30px | fixed; stays visible when collapsed |
| Source minimap | 7px | canvas, `duration * 2` px wide |
| Ruler | 24px | edit time; click = seek |
| Video lane | flexible | min ~46px at the smallest allowed height |
| Audio lane | flexible | video:audio = 52:44 |
| **Whole block** | 191px default | clamp 150..560, collapsed = 31px |

There is **no T lane**. Before the removal the fixed chrome was 95px
(1 border + 3 strip + 30 tool row + 7 minimap + 24 ruler + 30 text lane).
It is now 65px, and the freed 30px goes to the video/audio lanes.

`layout.timelineHeight` is persisted in `localStorage` (`t9-editor-lit.tlheight`).
'@

Add-Code @'
// WaveTimeline.svelte - the only geometry constants
const MINIMAP_H = 7;
const RULER_H = 24;
// border-t 1 + resize strip 3 + tool row 30 + minimap 7 + ruler 24
const FIXED_H = 65;

const LANES_H = $derived(Math.max(55, layout.timelineHeight - FIXED_H));
const VIDEO_H = $derived(Math.round((LANES_H * 52) / 96));
const AUDIO_H = $derived(LANES_H - VIDEO_H);

// layout.svelte.ts
const TIMELINE_H_DEFAULT = 191;
setTimelineHeight(px) {
  this.timelineHeight = Math.max(150, Math.min(560, Math.round(px)));
}
'@

# ---------------------------------------------------------------------------
# 4. UX principles
# ---------------------------------------------------------------------------
Add-Markdown @'
## 3. UI/UX principles and colour language

### Principles

1. **Density with air** - 30px tool row, 24px ruler, 9-12px labels. Everything
   the user touches is at least 28px tall (44px target area on the playhead).
2. **One accent** - brand blue (`--color-nc-gold` is the legacy token name,
   value `#4D8DFF`) marks selection, snap-on, focus and the primary action.
3. **Hover reveals, selection persists** - trim handles only appear on hover,
   but stay visible while the clip is selected.
4. **Every destructive action confirms itself** - a toast names the action
   (`Clip deleted - gap closed`, `3 lines cut`) and Undo is one `Ctrl+Z` away
   (30-step history).
5. **No modal for editing** - split, trim, mute, reorder all happen in place.
   The only overlays are the context menu and the shortcut sheet.
6. **Mode isolation** - leaving CUT unmounts the component tree, so the canvas,
   thumbnail cache and image elements are garbage-collected.

### Colour language

| Token / colour | Where | Meaning |
| -------------- | ----- | ------- |
| `#4D8DFF` (`nc-gold`) | DOM accent, selection borders, snap-on | interactive / selected |
| `#E5484D` (`nc-red`) | cut clips, hidden-track badge, mute icon | cut / danger |
| `#3DD68C` (`nc-green`) | kept transcript line in the preview chip | keep |
| `#D4AF37` (canvas amber) | waveform "keep" bars | kept source section |
| `#E5484D` (canvas red) | waveform fumble/repeat bars, minimap cuts | removed source |
| `#4A4D5C` (canvas grey) | silence bars | khamoshi |
| `#2B3040` (`nc-line`) | lane separators, ticks | structure |
| `#9AA3B5` / `#6F7787` | secondary / tertiary labels | de-emphasis |

Note: the canvas was written with the original Nanami gold and still uses
`#D4AF37` for kept waveform bars. The DOM accent moved to brand blue
(`#4D8DFF`); the token kept its old name (`.nc-gold`) to avoid a mass rename.
'@

Add-Code @'
// Traffic-light waveform: source time -> colour bucket (250 ms resolution)
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
'@

# ---------------------------------------------------------------------------
# 5. Feature catalogue
# ---------------------------------------------------------------------------
Add-Markdown @'
## 4. Full feature catalogue

### 4.1 Transport and playhead

| Feature | Trigger | Behaviour |
| ------- | ------- | --------- |
| Go to start | transport button | seeks to source `0` |
| Back 5s | button / `J` | `clamp(t - 5, 0, duration)` |
| Forward 5s | button / `L` | `clamp(t + 5, 0, duration)` |
| Play / pause | button / `Space` / `K` | drives the `<video>` element |
| Time readout | tool row centre | `m:ss.cc / total`; total = **source** duration |
| Click to seek | ruler, video lane, audio lane | `x -> editSec -> sourceAt()` |
| Drag playhead | vertical line + round handle | live scrub, snap 0.12s |
| Frame nudge | `Left` / `Right` on a lane | `1/30s`; `Shift` = 1s |
| Playhead sync | automatic | preview `timeupdate` moves the line; seeks move the video |

### 4.2 Clip editing

| Feature | Trigger | Behaviour |
| ------- | ------- | --------- |
| Select clip | click | selects **every transcript line** in that segment |
| Range select | `Shift` + click | every clip between the two clicks |
| Toggle clip | `Ctrl` / `Cmd` + click | flips the whole clip selection |
| Reveal clip | click without drag | seeks to the clip's first frame |
| Reorder | drag clip horizontally | 4px threshold; target by midpoint; transcript reorders live |
| Trim start | drag left edge inward | whole lines swept past the edge become cuts |
| Trim end | drag right edge inward | same, from the other side |
| Mute / unmute | speaker icon / context menu | preview mutes that source range; waveform ghosts to 28% |
| Delete clip | `Del` / `Backspace` / context menu | marks every line cut, gap closes, toast confirms |
| Split at playhead | `S` / toolbar / context menu | splits the line under the playhead, gold split mark stays visible |
| Cut at playhead | `Ctrl+Shift+X` | splits at the playhead and drops the head, leaving the gap |
| Snap | magnet button | snaps trims, playhead and seeks to line boundaries (80-120ms) |

Trim rules (deliberately one-way):

- Only **inward** trims are offered; extending would resurrect source that is
  already cut.
- Shortest result is `0.3s`; start edge keeps `+0.02s`, end edge `-0.02s`.
- Clip width never renders below 6px, so a short clip stays clickable.

### 4.3 AI / bulk actions

| Feature | Trigger | Behaviour |
| ------- | ------- | --------- |
| Auto-cut silences | sparkle button | scans silence >= 3s, cuts it, toast reports the count |
| Busy guard | automatic | the button disables while the scan runs |
| Failure toast | automatic | `AI scan failed: <reason>` |

### 4.4 Tracks and view

| Feature | Trigger | Behaviour |
| ------- | ------- | --------- |
| Source minimap | always visible | whole original; red spans = cut ranges |
| Video eye | `V` button | hides the video in preview, lane badge `VIDEO HIDDEN` |
| Audio eye | `A` button | mutes preview, dims waveform, badge `AUDIO HIDDEN` |
| Zoom in / out | `Ctrl+=` / `Ctrl+-`, toolbar | `x1.4` / `x0.714`, clamp 4..220 px per second |
| Zoom to fit | `Ctrl+0`, toolbar | viewport width / edit duration |
| Resize timeline | drag top edge | clamp 150..560, persists |
| Reset height | double-click strip | back to 191 |
| Collapse | toolbar chevron / `Ctrl+Alt+3` | 31px tool row only |
| Horizontal scroll | trackpad / scrollbar | custom `nc-scroll` styling |
| Split markers | always | gold 1.5px line at every user split, even if both halves are kept |

### 4.5 Selection and sync

| Feature | Trigger | Behaviour |
| ------- | ------- | --------- |
| Clip -> transcript | any clip selection | sets `project.cursor` to the clip's first line |
| Cursor -> preview | click | preview seeks to the clip start |
| Selection clearing | click empty lane | `deselectAll()` then seek |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` | 30 snapshots; includes order, trim, mute, track hides |
| Empty-state undo | `Undo` button in the lane | appears only when clips are all gone and history exists |
'@

# ---------------------------------------------------------------------------
# 6. Keyboard
# ---------------------------------------------------------------------------
Add-Markdown @'
## 5. Keyboard map (timeline-relevant)

| Keys | Action |
| ---- | ------ |
| `Space` / `K` | play / pause |
| `J` / `L` | seek -5s / +5s |
| `Left` / `Right` | one frame (lane focused) |
| `Shift + Left` / `Right` | one second |
| `S` | split at playhead |
| `Ctrl+Shift+X` | cut at playhead (split + drop the head) |
| `Del` / `Backspace` | cut selected line(s) |
| `X` / `V` | cut / keep current line, auto-advance |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | zoom in / out / fit |
| `Ctrl+Alt+3` | collapse or expand the timeline |
| `Ctrl+Alt+2` | collapse or expand the media panel |
| `Ctrl+Alt+F` | collapse or expand both |
| `Alt+3` | move focus to the timeline |
| `Ctrl+/` | shortcut sheet |

`Z` then `Left/Right` trims the current line's start, `C` then arrows trims
its end, `Shift+X` then arrows moves the line - these are transcript-first
variants of Clipchamp's timeline shortcuts (see `src/lib/shortcuts.ts`).
'@

# ---------------------------------------------------------------------------
# 7. Data model
# ---------------------------------------------------------------------------
Add-Markdown @'
## 6. Data model - source axis vs edit axis

```text
project.lines[]        transcript rows, source seconds, keep/cut
        |
        v  buildSegments()        contiguous kept lines -> Segment
project.segments[]     id = `seg-<first line id>`
        |
        v  orderSegments()        apply project.segmentOrder (drag result)
project.orderedSegments
        |
        v  computeOffsets()       gapless edit axis
Map<segId, {start, end}>  project.segmentOffsets
```

Why the segment id is `seg-<first line id>` and not an array index: deleting an
earlier clip must not renumber later clips, because selection, mute, trim and
order state all hang off that id.

The four pure functions below are unit-tested with `node --test` (no browser,
no Svelte runes). They are the riskiest maths in the app, so they live in
`src/lib/segments.ts` instead of the component.
'@

Add-Code @'
// src/lib/segments.ts (excerpt)
export function buildSegments(lines: TranscriptLine[]): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  for (const line of lines) {
    if (line.keep === 'cut') { cur = null; continue; }
    if (!cur || line.startSec - cur.endSec > 0.35) {
      cur = { id: `seg-${line.id}`, startSec: line.startSec, endSec: line.endSec, lines: [] };
      segs.push(cur);
    }
    cur.lines.push(line);
    cur.endSec = Math.max(cur.endSec, line.endSec);
  }
  return segs;
}

export function computeOffsets(segs: Segment[]) {
  const out = new Map<string, { start: number; end: number }>();
  let at = 0;
  for (const s of segs) {
    const len = Math.max(0, s.endSec - s.startSec);
    out.set(s.id, { start: at, end: at + len });
    at += len;
  }
  return out;
}

// edit time -> source time (null when the point is in a cut)
export function sourceAt(segs, offsets, editSec) {
  for (const s of segs) {
    const off = offsets.get(s.id);
    if (!off) continue;
    if (editSec >= off.start && editSec < off.end) return s.startSec + (editSec - off.start);
  }
  return null;
}

// drag target: first clip whose midpoint is right of the pointer
export function dropIndex(segs, offsets, draggedId, editSec) {
  const others = segs.filter((s) => s.id !== draggedId);
  for (let i = 0; i < others.length; i++) {
    const off = offsets.get(others[i].id);
    if (!off) continue;
    if (editSec < off.start + (off.end - off.start) / 2) return i;
  }
  return others.length;
}
'@

# ---------------------------------------------------------------------------
# 8. Recipes
# ---------------------------------------------------------------------------
Add-Markdown @'
## 7. Interaction recipes

### Reorder a clip (transcript follows)

1. Pointer down on a video clip - selection is applied immediately.
2. Move less than 4px: it is a click, so the playhead jumps to the clip start.
3. Move past 4px: the clip lifts (`z-20`, gold border, shadow).
4. On release, `dropIndex()` compares the pointer's **edit second** with each
   other clip's midpoint and returns the target index.
5. `project.moveSegment(id, target)` rewrites `segmentOrder`; the transcript
   panel re-renders `project.orderedLines`, so the rows move with the picture.

### Trim a clip

1. Hover the clip - the 7px edge handles fade in.
2. Drag inward; the previewed edge time appears in a floating mono chip.
3. Optional snap pulls the edge to a line boundary (0.08s tolerance).
4. On release, `trimSegmentStartTo` / `trimSegmentEndTo` marks swept lines
   `cut` and clamps the edge line, so the gap closes exactly.
5. Toast: `Clip start trimmed` / `Clip end trimmed`.

### Mute a clip

Click the speaker on the clip (or right-click -> Mute). The waveform stays
visible but drops to 28% alpha - Clipchamp keeps muted shapes readable - and
the preview sets `video.muted = true` while the playhead is inside that clip.

### Auto-cut silence

Sparkle button -> `project.autoCutSilence(3.0)` -> every silence range >= 3s is
cut -> toast `N lines cut (silence >= 3s)`. The button is disabled while the
async scan runs, so double-clicks cannot queue two scans.

### Delete a clip

`Del` or context menu -> every line in the segment becomes `cut` -> the
segment disappears from `buildSegments()` -> later offsets slide left. No
special ripple code is needed; the edit axis is always derived.
'@

Add-Code @'
// Drag reorder - threshold, drop index, then the store owns the order
function onClipDown(e: PointerEvent, seg) {
  selectSegment(seg, e);
  if (e.shiftKey || e.ctrlKey || e.metaKey) return;

  const startX = e.clientX;
  let moved = false;
  const move = (ev) => {
    dragDx = ev.clientX - startX;
    if (!moved && Math.abs(dragDx) < 4) return;
    moved = true;
    dragId = seg.id;
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const id = dragId;
    dragId = null; dragDx = 0;
    if (!moved) { player.seek(seg.startSec); return; }
    if (!id || !laneEl) return;

    const rect = laneEl.getBoundingClientRect();
    const editSec = clamp((ev.clientX - rect.left) / zoom, 0, editDur);
    const from = segments.findIndex((s) => s.id === id);
    const target = dropIndex(segments, offsets, id, editSec);
    if (target !== from) {
      project.moveSegment(id, target);
      toast.push('info', 'Clip moved - transcript reordered');
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
'@

# ---------------------------------------------------------------------------
# 9. Zero-RAM rendering
# ---------------------------------------------------------------------------
Add-Markdown @'
## 8. Zero-RAM rendering strategy

The timeline never holds media in memory. Three canvases paint the lanes:

| Canvas | What it draws | Cost control |
| ------ | ------------- | ------------ |
| `filmCanvas` | filmstrip frames clipped to each segment | only frames in the viewport (+/-200px), max ~260 `Image` objects, evicted when far away |
| `waveCanvas` | 2px waveform bars, coloured by source bucket | reads `project.waveform.peaks`, no audio decoding in the UI |
| `miniCanvas` | the whole source, red where cut | 2px per second, 7px tall |

Key rules:

- Thumbnails are individual JPEGs fetched through `thumbUrl(strip, i)`; a
  2-hour timeline never pulls thousands of frames into the heap.
- `ensureThumbs(from, to)` maps **edit seconds back to source seconds** per
  visible segment before fetching, so reordered clips show the correct frames.
- Muted clips are drawn at 28% alpha instead of being skipped.
- Everything redraws from reactive dependencies (`zoom`, `contentW`, `colours`,
  `segments`, `offsets`, `splitMarkPositions`, `LANES_H`); no manual dirty
  flags, no timers.
'@

Add-Code @'
// Viewport-only thumbnails with eviction
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

// Waveform bars: source second -> peak -> coloured 2px column
for (let px = 0; px < wpx; px += 2) {
  const sourceSec = s.startSec + px / zoom;
  const pi = Math.min(peaks.length - 1, Math.floor((sourceSec / dur) * peaks.length));
  const p = peaks[Math.max(0, pi)] ?? 0;
  const hgt = Math.max(1, p * (AUDIO_H - 10));
  ctx.fillStyle = sourceColour(sourceSec);
  ctx.fillRect(x0 + px, mid - hgt / 2, 2, hgt);
}
'@

# ---------------------------------------------------------------------------
# 10. Accessibility
# ---------------------------------------------------------------------------
Add-Markdown @'
## 9. Accessibility and input

- Ruler, video lane, audio lane and playhead expose `role="slider"` with
  `aria-valuemin`, `aria-valuemax` and `aria-valuenow` (edit seconds).
- Every lane is `tabindex="0"`; `Left/Right` nudge one frame there.
- Clips are `role="button"`, `tabindex="0"`, `aria-pressed` for selection;
  `Enter` / `Space` selects them, and the timeline keeps focus.
- Every icon-only button carries a `title` that names the action and, when it
  exists, its shortcut (`Split at playhead (S)`).
- `Alt+3` focuses the timeline region; `Alt+1..5` cover rail, transcript,
  timeline, stage, header.
- Toasts announce the result of every edit, so a keyboard user gets the same
  confirmation a mouse user sees.
- The whole component is destroyed on mode switch, so no stale focus ring or
  hidden textarea survives a mode change.
'@

# ---------------------------------------------------------------------------
# 11. Edge states
# ---------------------------------------------------------------------------
Add-Markdown @'
## 10. Empty, error and edge states

| State | What the user sees | Implementation |
| ----- | ------------------ | -------------- |
| No media | empty lanes, preview shows "Overtime nahi karna hai." | `project.media == null` |
| All clips cut | centred pill "Saare clips cut ho gaye" + `Undo` when history exists | `segments.length === 0` |
| No transcript lines | "Koi clip nahi" pill | `project.lines.length === 0` |
| Video hidden | video invisible in preview, `VIDEO HIDDEN` badge on the lane | `hiddenTracks` includes `video` |
| Audio hidden | waveform dimmed, preview muted, `AUDIO HIDDEN` badge | `hiddenTracks` includes `audio` |
| Clip muted | ghosted waveform (28%), red speaker icon | `mutedSegments` |
| Very short clip | minimum 6px hit area | `Math.max(6, width)` |
| Trim too small | no-op (release < 0.02s delta or < 0.3s result) | trim guards |
| Zoom extremes | 4..220 px/s | `clamp` in `nudgeZoom` |
| Long timeline | tick loop capped at 3000 ticks | `ticks` derived |
| Collapsed | only the 31px tool row | `layout.timelineCollapsed` |
| Corrupt localStorage | silently ignored, clean start | `restoreUiState` try/catch |
'@

# ---------------------------------------------------------------------------
# 12. Text removal
# ---------------------------------------------------------------------------
Add-Markdown @'
## 11. Text lane removal (current behaviour)

**Decision (21 Oct 2026):** the app ships with **no text feature at all**.
The user cannot do text-related work on the timeline - and no dead control
pretends otherwise.

### What was removed

| Surface | Before | Now |
| ------- | ------ | --- |
| `T` lane | 30px lane under the ruler | gone; lanes are 30px taller |
| `Add text` toolbar button | opened a text editor at the playhead | gone |
| Text clips | draggable / trimmable gold blocks | gone |
| Text context menu | Edit / Hide / Delete text | gone |
| Text editor modal | text, style, duration | gone |
| Preview overlays | title / heading / code-zoom captions | gone |
| `Del` path | deleted the selected text clip | deletes transcript lines only |
| `TextClip` type | `title`, `heading`, `code-zoom` | removed from `types.ts` |
| `project.texts` | array + 6 store methods | removed |
| Track id | `'text' | 'video' | 'audio'` | `'video' | 'audio'` |
| Persistence | `texts` inside `t9.timelineUi:*` | key ignored on restore |
| `MenuIcon` | `'text'` glyph | removed |

### Why

1. The timeline is the cut surface; text was a half-finished overlay feature
   with no export path, so it added UI without shipping value.
2. Users could not reliably do text work there - the honest fix is to remove
   the lane until it can be done properly.
3. Less state: no second selection model, no text persistence, no text undo
   entries, no extra lane height.
4. Zero-RAM rule: a real overlay pipeline (burn-in / ASS) needs a separate
   render path; it should not ship as a prototype lane.

### Compatibility

- Old `localStorage` entries may still contain `"texts": [...]`. Restore
  ignores unknown keys, so old projects open with their cuts, order, mutes and
  track hides intact. Nothing throws.
- Old `hiddenTracks: ["text"]` is filtered out (`TrackId` is now video/audio).
- No SQLite migration is needed: text clips were never persisted server-side.

### If text comes back later

Treat it as a **feature, not a lane**:

- [ ] Define the data model on the **edit axis** (reorder/trim must move it).
- [ ] Restore `TEXT_H = 30` and `FIXED_H = 95`, or make the lane collapsible.
- [ ] Re-add `TextClip`, store methods, persistence and undo snapshots.
- [ ] Decide the render path: live preview overlay + burn-in at export
      (ASS subtitles or drawtext), never a per-frame JS decoder.
- [ ] Add tests for trimming a text clip past its own start/end.
- [ ] Keyboard + screen-reader story for the lane before shipping.
'@

Add-Code @'
// The removed surface, kept here as a checklist - do NOT paste back half of it.
//
// types.ts         TextClip { kind: 'title' | 'heading' | 'code-zoom' }
// project store    texts, selectedTextId, addText, updateText, moveText,
//                  removeText, toggleTextHidden, selectText, clearTextSelection
// WaveTimeline     TEXT_H, text lane, Add text, text context menu, editor modal
// VideoPreview     editPos + activeTexts overlay block
// App.svelte       delete-selected-text branch
// MenuIcon         'text' glyph
//
// A grep for these names must stay empty while the feature is off:
//   TextClip | project.texts | openTextEditor | TEXT_H | "Add text"
'@

# ---------------------------------------------------------------------------
# 13. Verification
# ---------------------------------------------------------------------------
Add-Markdown @'
## 12. Verification

Run from `Clipchamp_Bunny/`:

```powershell
npm run check    # svelte-check + tsc -> 0 errors, 0 warnings (expected)
npm test         # node --test -> 14/14
npm run lint     # prettier --check . (see note below)
npm run verify:fast
```

Known local caveat: `tools/branding/*.mjs` are untracked files in this
workspace and may fail `prettier --check`; that is unrelated to the timeline.

Deploy (the only path that reaches the desktop app):

```powershell
cd Clipchamp_Bunny
pwsh -File tools\deploy.ps1 -Status
pwsh -File tools\deploy.ps1 -Doctor
```

Ledger rule: only `shipped` means the change reached the taskbar app.

Manual smoke test:

1. Open a project with at least three kept clips.
2. Drag clip 2 before clip 1 - transcript rows reorder with it.
3. Trim both edges - swept lines disappear, gap closes.
4. Mute a clip - waveform ghosts, preview goes silent inside it.
5. `Ctrl+Alt+3` collapse, expand, resize, double-click reset.
6. Confirm there is **no T lane, no Add text button, no text in the preview**.
'@

# ---------------------------------------------------------------------------
# 14. File map
# ---------------------------------------------------------------------------
Add-Markdown @'
## 13. File map and known limits

| File | Role |
| ---- | ---- |
| `src/lib/components/cut/WaveTimeline.svelte` | the whole bottom block: tool row, lanes, playhead, zoom, context menu |
| `src/lib/components/cut/VideoPreview.svelte` | preview; playhead sync and cut-range skip (no text overlays) |
| `src/lib/segments.ts` | pure edit-axis maths (segments, offsets, drop index) - unit tested |
| `src/lib/stores/project.svelte.ts` | lines, order, trims, mutes, hidden tracks, undo, autosave |
| `src/lib/stores/layout.svelte.ts` | timeline height, collapse, focus areas |
| `src/lib/stores/player.svelte.ts` | current time, zoom, play state |
| `src/lib/shortcuts.ts` | the shortcut table shown by `Ctrl+/` |
| `src/App.svelte` | global key handling, focus routing |
| `docs/timeline-logic/build.ps1` | this notebook's generator |

### Known limits (honest list)

- Trims are inward-only; there is no "extend clip" gesture.
- No marquee selection on the lanes; selection is clip-based.
- No drag between video and audio lanes (audio belongs to the video clip).
- No waveform zoom detail switch; bars are 2px at every zoom.
- Auto-cut threshold is fixed at 3s (the Media mode DEAD AIR screen has the
  slider).
- Timeline height is persisted, collapse state is not.
- Text is absent by design (see section 11).
'@

# ---------------------------------------------------------------------------
# 15. Changelog
# ---------------------------------------------------------------------------
Add-Markdown @'
## 14. Changelog

| Date | Change |
| ---- | ------ |
| 21 Oct 2026 | Text lane and every text-clip surface removed; `FIXED_H` 95 -> 65; docs updated; this notebook added. |
| 21 Oct 2026 | Timeline documented end-to-end: metrics, features, data model, zero-RAM rendering, edge states. |
'@

# ---------------------------------------------------------------------------
# Assemble
# ---------------------------------------------------------------------------
$notebook = @{
  cells          = @($cells)
  metadata       = @{
    title       = 'T9 Editor LIT - Timeline UI/UX + Feature Map'
    description = 'Anatomy, every timeline feature, interaction recipes, data model and the text-lane removal. Generated by docs/timeline-logic/build.ps1.'
    kernelspec  = @{
      display_name = 'TypeScript'
      language     = 'typescript'
      name         = 'typescript'
    }
    language_info = @{
      name           = 'typescript'
      mimetype       = 'text/typescript'
      file_extension = '.ts'
    }
  }
  nbformat       = 4
  nbformat_minor = 5
}

$out = Join-Path $REPO 'docs\TIMELINE_UI_UX.ipynb'
$json = ConvertTo-Json -InputObject $notebook -Depth 30
[IO.File]::WriteAllText($out, $json, (New-Object System.Text.UTF8Encoding($false)))

# Validate: parse the JSON back and confirm the cell count survived.
$check = [IO.File]::ReadAllText($out) | ConvertFrom-Json
Write-Host ("Wrote {0}" -f $out)
Write-Host ("Cells: {0} (markdown {1}, code {2})" -f `
    $check.cells.Count, `
  @($check.cells | Where-Object { $_.cell_type -eq 'markdown' }).Count, `
  @($check.cells | Where-Object { $_.cell_type -eq 'code' }).Count)
