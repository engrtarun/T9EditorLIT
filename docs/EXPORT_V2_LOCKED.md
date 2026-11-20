# Export v2 — locked

**Status:** approved and frozen. Tag **`export-v2-locked`** points at `4ce648c`,
the last commit that changed the engine. The user approved the output on
2026-11-19 and asked for this version to be locked: the pipeline is not to be
"cleaned up" or re-shaped without a new version and a new proof.

**Engine:** `src-tauri/src/export.rs` → "the single-source pipeline (v2)"
(section starts around the `v2` banner). The frontend only chooses presets
(`Clipchamp_Bunny/src/lib/export-presets.ts`); all timing lives in Rust.

## What v2 is

Pieces used to be cut **with** their audio and stitched by the concat demuxer.
That shape cannot hold a timeline together:

- every piece carried its own AAC encode, and every AAC encode starts with
  ~2112 priming samples (~48 ms) of silence that a stream copy keeps
  mid-stream;
- a piece whose length was not whole frames made the container duration
  audio-driven, so the demuxer stacked the next piece at the *audio* length
  and left holes in the video timestamp grid — 47 gaps, 50.9 fps average,
  and freezes.

v2 splits the job instead:

| Stage | What happens | Why |
| --- | --- | --- |
| Cut | video-only pieces, written as **MPEG-TS** | 90 kHz timebase = 1500 ticks per frame at 60 fps exactly (Matroska's 1/1000 does not) |
| Concat | the pieces are joined **without re-encoding** | no per-piece audio, so no priming silence at a join |
| Audio | the whole kept audio track in **one filter-graph pass** (`asplit` + `atrim` + `concat`, one encode) | one AAC start, one continuous clock |
| Mux | final `-c copy` of the joined video + the one audio track | no generation loss after the pieces exist |

Frame snapping (`n / fps`) and the previous-keyframe roll (`Piece.roll`) make
each cut land on the frame grid, so A/V lengths match and a sub-frame kept
piece is never dropped (floor = one frame).

### The `;` rule

The concat clause in the one-pass audio graph is a filter of its own. Without
the `;` before `concat=…`, FFmpeg reads it as trailing garbage and the join
fails. That fix is `4ce648c` and it is part of the locked engine — do not
"simplify" the graph string.

## Approved proof (SHORT6)

Real project: `InShot_20261118_101842053.mp4`, 1080×1920, 60 fps, 277.976 s,
50 kept pieces.

| Measure | Result |
| --- | --- |
| Video frames | **4570 / 4570** |
| Timestamp gaps | **0** |
| Frame delta | **1500 ticks** (90 kHz, exactly 60 fps) |
| Audio duration | **76.166667 s**, 1.5 ms inside the video |
| Join failures | 0 |

This is the output the user approved. Any change that makes these numbers
worse is a regression, not an improvement.

## How to verify after a build

1. Export SHORT6 (or any 60 fps project) with **Fast** and with **Quality**.
2. On the output:
   - `ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames,r_frame_rate,duration -of json <out>`
   - `ffprobe -v error -select_streams a:0 -show_entries stream=duration -of json <out>`
3. Frames must equal the sum of kept frames, `r_frame_rate` must be the source
   rate, and audio duration must be within a few ms of video duration.

## What is *not* locked

Sequence/canvas export (9:16, 1:1, 4:5, 4:3) still uses the old per-piece
path. Moving it onto v2 is a separate task (see `TODO.md`), and it does not
change this engine's contract for single-source exports.
