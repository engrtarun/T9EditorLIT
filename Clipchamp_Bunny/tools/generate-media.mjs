/**
 * Pre-bakes the demo media the same way the Rust backend does it at runtime.
 *
 * This exists so the UI prototype can be developed against REAL data (real
 * waveform peaks, a real filmstrip, a real video) instead of placeholders.
 * The Tauri build replaces this with the live Rust commands:
 *
 *   waveform  â†’ ffmpeg -v error -i SRC -ac 1 -ar 48000 -f s16le -
 *   thumbs    â†’ ffmpeg -i SRC -vf "fps=1,scale=160:-2" -q:v 5 -f image2 thumb_%05d.jpg
 *
 * Usage: node tools/generate-media.mjs [sourceVideo]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'assets');
const THUMBS = path.join(OUT, 'thumbs');

const FFMPEG =
  process.env.FFMPEG_PATH ??
  'C:\\Users\\pocot\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
const FFPROBE = FFMPEG.replace(/ffmpeg\.exe$/, 'ffprobe.exe');

const SRC =
  process.argv[2] ??
  'C:\\Users\\pocot\\Music\\T9EditorLIT\\resource_Clipchamp\\clipchamp_OBSrecord.mp4';

/** Mirrors src-tauri/src/waveform.rs */
const SAMPLE_RATE = 48000;
const BARS = 4096;
/** Mirrors src-tauri/src/thumbnail.rs */
const THUMB_FPS = 1;
const THUMB_WIDTH = 160;
const JPEG_QUALITY = '5';

fs.mkdirSync(THUMBS, { recursive: true });

// ---------------------------------------------------------------- probe
console.log('Â· probing', SRC);
const probe = JSON.parse(
  execFileSync(
    FFPROBE,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', SRC],
    { encoding: 'utf8' }
  )
);
const v = probe.streams.find((s) => s.codec_type === 'video');
const a = probe.streams.find((s) => s.codec_type === 'audio');
const durationSecs = Number(probe.format.duration);
const [num, den] = v.avg_frame_rate.split('/');
const fps = Number(num) / Number(den);
console.log(
  `  ${v.width}x${v.height} ${fps}fps Â· ${durationSecs.toFixed(2)}s Â· ${(probe.format.size / 1048576).toFixed(2)} MB`
);

// ---------------------------------------------------------------- waveform
console.log('Â· extracting waveform (streaming, zero-RAM)');
const pcm = spawnSync(
  FFMPEG,
  ['-v', 'error', '-i', SRC, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'],
  {
    maxBuffer: 1 << 30
  }
);
if (pcm.status !== 0) throw new Error('ffmpeg waveform failed: ' + pcm.stderr.toString());

const samples = new Int16Array(pcm.stdout.buffer, pcm.stdout.byteOffset, pcm.stdout.length >> 1);
const samplesPerBar = Math.max(1, Math.floor(samples.length / BARS));
const peaks = new Array(BARS).fill(0);
let bucket = 0;
let filled = 0;
let cursor = 0;
for (let i = 0; i < samples.length; i++) {
  const abs = Math.abs(samples[i]);
  if (abs > bucket) bucket = abs;
  filled++;
  if (filled >= samplesPerBar) {
    if (cursor < BARS) peaks[cursor++] = bucket;
    bucket = 0;
    filled = 0;
  }
}
// Normalise to the global peak, exactly like `waveform.rs` does.
const maxPeak = Math.max(...peaks) || 1;
for (let i = 0; i < peaks.length; i++) peaks[i] = Number((peaks[i] / maxPeak).toFixed(4));

const waveform = {
  durationSecs,
  bars: BARS,
  peaks,
  cachePath: null
};
fs.writeFileSync(path.join(OUT, 'waveform.json'), JSON.stringify(waveform));
console.log(`  ${BARS} bars Â· peak ${Math.max(...peaks).toFixed(3)}`);

// ---------------------------------------------------------------- filmstrip
console.log('Â· extracting filmstrip (1 fps)');
for (const f of fs.readdirSync(THUMBS)) fs.unlinkSync(path.join(THUMBS, f));
execFileSync(FFMPEG, [
  '-v',
  'error',
  '-i',
  SRC,
  '-vf',
  `fps=${THUMB_FPS},scale=${THUMB_WIDTH}:-2`,
  '-q:v',
  JPEG_QUALITY,
  '-f',
  'image2',
  path.join(THUMBS, 'thumb_%05d.jpg')
]);
const thumbs = fs
  .readdirSync(THUMBS)
  .filter((f) => f.endsWith('.jpg'))
  .sort();
const height = Math.floor(((v.height / v.width) * THUMB_WIDTH) / 2) * 2;
fs.writeFileSync(
  path.join(THUMBS, 'manifest.json'),
  JSON.stringify({
    durationSecs,
    fps: THUMB_FPS,
    count: thumbs.length,
    width: THUMB_WIDTH,
    height,
    dir: '/assets/thumbs'
  })
);
console.log(`  ${thumbs.length} thumbs @ ${THUMB_WIDTH}x${height}`);

// ---------------------------------------------------------------- video + media.json
const dest = path.join(OUT, 'clipchamp_OBSrecord.mp4');
if (!fs.existsSync(dest)) {
  fs.copyFileSync(SRC, dest);
  console.log('Â· copied video');
}

const media = {
  id: 'obs-clipchamp',
  name: 'clipchamp_OBSrecord.mp4',
  url: '/media/clipchamp_OBSrecord.mp4',
  durationSecs,
  width: v.width,
  height: v.height,
  fps,
  sizeBytes: Number(probe.format.size),
  videoCodec: v.codec_name,
  audioCodec: a?.codec_name ?? null,
  sampleRate: a ? Number(a.sample_rate) : null,
  channels: a ? Number(a.channels) : null
};
fs.writeFileSync(path.join(OUT, 'media.json'), JSON.stringify(media, null, 2));
console.log('Â· wrote media.json');
console.log('DONE â†’', OUT);
