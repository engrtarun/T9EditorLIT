import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BITRATES,
  GIF_MAX_SECS,
  RESOLUTIONS,
  SAMPLE_RATES,
  audioFilter,
  defaultFileName,
  estimateGifBytes,
  estimateMp3Bytes,
  formatPreset,
  targetFrame
} from './export-presets.ts';

test('the format table carries the extension FFmpeg needs', () => {
  assert.equal(formatPreset('video').ext, 'mp4');
  assert.equal(formatPreset('gif').ext, 'gif');
  assert.equal(formatPreset('mp3').ext, 'mp3');
});

test('the resolution table is Clipchamp’s list, in order', () => {
  assert.deepEqual(
    RESOLUTIONS.map((r) => r.id),
    ['source', '480p', '720p', '1080p', '4k']
  );
  assert.equal(RESOLUTIONS[0].shortSide, null, 'the source is never rescaled');
  assert.equal(RESOLUTIONS[4].shortSide, 2160);
});

test('a smaller target scales the short side down', () => {
  assert.deepEqual(targetFrame('720p', 1920, 1080), { width: 1280, height: 720 });
  assert.deepEqual(targetFrame('480p', 1920, 1080), { width: 854, height: 480 });
});

test('a portrait source is scaled by its width', () => {
  assert.deepEqual(targetFrame('720p', 1080, 1920), { width: 720, height: 1280 });
});

test('the source size and upscaling both leave the frame alone', () => {
  assert.equal(targetFrame('source', 1920, 1080), null);
  assert.equal(targetFrame('1080p', 1920, 1080), null, 'already 1080p');
  assert.equal(targetFrame('4k', 1920, 1080), null, 'upscale is never done');
});

test('a missing frame size means no decision', () => {
  assert.equal(targetFrame('720p', 0, 0), null);
});

test('the default file name follows the format', () => {
  assert.equal(defaultFileName('My Clip', 'video'), 'My Clip (cut).mp4');
  assert.equal(defaultFileName('My Clip', 'gif'), 'My Clip.gif');
  assert.equal(defaultFileName('My Clip', 'mp3'), 'My Clip (audio).mp3');
  assert.equal(defaultFileName('', 'mp3'), 't9-editor-lit (audio).mp3');
});

test('the mp3 estimate is bitrate × seconds', () => {
  assert.equal(estimateMp3Bytes(60, 192), 1_440_000);
  assert.equal(estimateMp3Bytes(0, 192), 0);
  assert.equal(estimateMp3Bytes(10, 0), 0);
});

test('the gif estimate grows with the length', () => {
  const short = estimateGifBytes(5);
  const long = estimateGifBytes(10);
  assert.ok(long > short, 'twice the clip, twice the file');
  assert.equal(estimateGifBytes(0), 0);
});

test('the audio filter trims and joins the kept ranges', () => {
  const one = audioFilter([{ start: 1, end: 4.5 }]);
  assert.ok(one?.includes('atrim=start=1.000000:end=4.500000'), one ?? '');
  assert.ok(one?.includes('[aout]'), one ?? '');
  assert.ok(!one?.includes('concat'), 'one range needs no concat');

  const many = audioFilter([
    { start: 0, end: 2 },
    { start: 5, end: 7.5 },
    { start: 9, end: 10 }
  ]);
  assert.ok(many?.includes('concat=n=3:v=0:a=1'), many ?? '');
  assert.ok(many?.includes('[0:a]atrim=start=5.000000:end=7.500000'), many ?? '');
  assert.ok(many?.includes('[a1]'), many ?? '');
});

test('no ranges means no filter — the whole recording', () => {
  assert.equal(audioFilter([]), null);
});

test('the offered bitrates and sample rates are the standard ones', () => {
  assert.deepEqual([...BITRATES], [128, 192, 256, 320]);
  assert.deepEqual([...SAMPLE_RATES], [44100, 48000]);
  assert.equal(GIF_MAX_SECS, 15);
});
