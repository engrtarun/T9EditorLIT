# Preview pipeline — why some files show a black screen, and what the app does instead

**Status:** shipped (`preview_proxy.rs`, `VideoPreview.svelte`, `project.svelte.ts`).
**Test files used to verify it:** a 1.04 GB 10-bit HEVC MKV and a 3.5 GB x264 MKV, both real episodes.

## The problem is the decoder, not the file size

The first instinct is that a 5 GB file is "too big to preview". It is not.
Tauri's `asset://` protocol serves the file over HTTP with `Range` requests, so
the webview streams it exactly like a 50 MB clip — the process never holds the
file. What actually fails is the **codec**:

| The user's file                        | WebView2 (Chromium) | What they saw |
| -------------------------------------- | ------------------- | ------------- |
| H.264 8-bit 4:2:0 in MP4               | plays               | the video     |
| VP8 / VP9 / AV1 in WebM                | plays               | the video     |
| HEVC / H.265 (phones, cameras, BluRay) | no                  | black         |
| H.264 10-bit, 4:2:2, 4:4:4             | no                  | black         |
| any `.mkv`, `.mov`, `.MTS` container   | no                  | black         |
| AC3 / EAC3 / DTS / TrueHD audio        | no                  | silence       |

So a perfectly ordinary `x264` episode in an MKV is unwatchable **without a
single frame needing to be re-encoded** — only the wrapper is wrong.

## Three plans, cheapest first

`preview_plan(path)` reads the header with `ffprobe` (never the whole file) and
returns one of:

| `kind`      | When                                                   | Cost                                  |
| ----------- | ------------------------------------------------------ | ------------------------------------- |
| `native`    | the `<video>` element can play the source as-is        | nothing                               |
| `remux`     | picture is playable, container or audio is not         | `-c copy`, **169 s** for 3.5 GB       |
| `transcode` | WebView2 cannot decode the picture (HEVC, 10-bit, HDR) | 720p H.264, **3.16x realtime**        |

Measured on the i3 in this repo, not estimated:

```
remux      3.5 GB x264 MKV -> 2.92 GB MP4, 1920x1080, yuv420p, 169.5 s
transcode  1.04 GB HEVC 10-bit -> 117 MB MP4, 720x406, yuv420p, 837.6 s
```

Encoders are tried in this order and the first that works is used:
`h264_qsv` → `h264_nvenc` → `h264_amf` → `libx264`. On this machine QSV
**decode** of 10-bit HEVC is slower than software (4.38x vs 3.54x end to end),
and `-hwaccel d3d11va` was slower still (2.75x) because of the GPU→CPU download,
so the software path is what actually runs. The GPU entries stay for machines
where they do help.

## What the proxy is, and what it is not

The proxy is a **view**. It lives at
`<app_data>/cache/proxy/<source_key>.mp4`, where `source_key` is the source's
canonical path + size + mtime — the same key the waveform, filmstrip and poster
use. Replacing a source file therefore invalidates its proxy for free.

Everything that produces output keeps reading the **original** file:

| Consumer                     | Reads             |
| ---------------------------- | ----------------- |
| export / cut                 | `sourcePath`      |
| transcript                   | `sourcePath`      |
| waveform, filmstrip, poster  | `sourcePath`      |
| `<video>` element            | the proxy's URL   |

Two consequences that are easy to get wrong, and are therefore tested:

1. **The proxy's dimensions must never become the project's dimensions.**
   `VideoPreview` writes `videoWidth/videoHeight` into `project.media`, and
   `ExportMode` sizes its export canvas from those. A 720p proxy would silently
   downgrade a 1080p or 4K export. Dimensions are only taken when no proxy is in
   play.
2. **A proxy URL must never leak into the media library.** The library entry is
   persisted, and a clip added from it would stream the 720p stand-in — or a
   dangling path once the cache is cleared.

## Failure modes the code defends against

| Failure                                                    | Defence                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| A truncated MP4 served forever as "cached"                 | written as `<key>.part.mp4`, renamed only after FFmpeg exits 0      |
| Two builds writing the same temporary file                 | proxy builds are serialised by a process-wide mutex                 |
| A cancel from the previous job killing the next build      | the flag is cleared at the start of every build, not just transcode |
| Opening project B while A is still encoding                | a generation number; a stale call writes nothing                    |
| A 4K source remuxed and left 4K to decode                  | above 1080p it is a proxy, not a copy                               |
| An audio file with cover art treated as "has a picture"    | `attached_pic` streams are skipped                                  |
| HDR shown washed out                                       | PQ / HLG are tone mapped on the way in                              |

## What the user sees

While a proxy is building, the preview stage shows a real percentage
(`-progress pipe:1`, `out_time_us`), the reason it is building, and an
**External player me kholo** button that hands the original file to whatever
player is installed. Transcript, waveform, cuts and export keep working the
whole time — only the picture waits.

The bar only appears when the main source is the thing being prepared. An extra
clip has its own file and its own verdict, so it is never covered by the main
source's progress card.

## Cache cost (known trade-off)

A `remux` proxy is a **full copy** of the source's video stream — 2.92 GB for a
3.5 GB episode. That is the price of never re-encoding a playable picture, and
it doubles the disk used by that file. There is no eviction yet; see
`TODO.md`.

## Verifying a change here

```powershell
cd Clipchamp_Bunny
npm run check                       # svelte-check, must be 0 errors
npx prettier --check src/lib/...    # the touched frontend files
cd src-tauri; cargo check --tests   # type-checks the module AND its tests
```

`cargo test` is refused on this machine by the cargo shim (`AGENTS.md` §11) —
`ci.yml` runs it on GitHub's Windows runner for pull requests instead.

To prove playback without the GUI, serve the proxy over HTTP with range
support and check the element in Chromium:

```js
// decoded frame count must rise, duration must match, error must be null
v.currentTime = 1500;
v.play();
// then draw a frame to a canvas and confirm it is not uniformly black
```
