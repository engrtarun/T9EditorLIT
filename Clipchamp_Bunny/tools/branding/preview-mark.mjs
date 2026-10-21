#!/usr/bin/env node
/**
 * Render the generated brand mark the way the app will show it.
 *
 * WHY
 * ---
 * The brand mark is generated code (tools/branding/trace-mark.mjs writes
 * src/lib/components/dashboard/BrandMark.svelte). This script parses the
 * path out of that component and paints it with the board's gradient, so the
 * mark can be looked at without a browser or a screenshot tool.
 *
 * It is a *preview*, not the app: it shows the same path and the same
 * colours, on the app's panel colour.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePng, fillPolygons } from './png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT = resolve(
  HERE,
  '..',
  '..',
  'src',
  'lib',
  'components',
  'dashboard',
  'BrandMark.svelte'
);

const svelte = readFileSync(COMPONENT, 'utf8');
const d = svelte.match(/<path d="([^"]+)"/)[1];
const view = svelte
  .match(/viewBox="([^"]+)"/)[1]
  .split(' ')
  .map(Number);

/* The path is a sequence of "M x y L x y ... Z" subpaths. The command
   letters are stripped first, then the coordinates are read in pairs. */
const loops = [];
for (const part of d.split('M').slice(1)) {
  const body = part.replace(/Z/g, ' ').replace(/L/g, ' ');
  const n = body.match(/-?[\d.]+/g);
  if (!n) continue;
  const nums = n.map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  if (pts.length > 2) loops.push(pts);
}

const SCALE = 2;
const W = Math.round(view[2] * SCALE);
const H = Math.round(view[3] * SCALE);
const scaled = loops.map((l) => l.map(([x, y]) => [(x - view[0]) * SCALE, (y - view[1]) * SCALE]));

const PANEL = [26, 29, 36];
/* Fill onto a transparent background first: the alpha channel is what says
   "this pixel is the mark", so the background must start at zero. */
const rgba = fillPolygons(scaled, W, H, [255, 255, 255, 255], [0, 0, 0, 0]);

/* The board's gradient, applied across the mark. */
const STOPS = [
  [0, [238, 246, 255]],
  [0.22, [158, 200, 255]],
  [0.45, [77, 141, 255]],
  [0.72, [30, 69, 160]],
  [1, [10, 42, 102]]
];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (rgba[o + 3] < 128) {
      /* Not part of the mark: the app's panel colour. */
      rgba[o] = PANEL[0];
      rgba[o + 1] = PANEL[1];
      rgba[o + 2] = PANEL[2];
      rgba[o + 3] = 255;
      continue;
    }
    const t = Math.min(1, (x / W) * 0.55 + (y / H) * 0.45);
    let c = STOPS[0][1];
    for (let s = 0; s < STOPS.length - 1; s++) {
      if (t >= STOPS[s][0] && t <= STOPS[s + 1][0]) {
        const k = (t - STOPS[s][0]) / (STOPS[s + 1][0] - STOPS[s][0]);
        c = STOPS[s][1].map((v, i) => Math.round(v + (STOPS[s + 1][1][i] - v) * k));
        break;
      }
    }
    if (t > STOPS[STOPS.length - 1][0]) c = STOPS[STOPS.length - 1][1];
    rgba[o] = c[0];
    rgba[o + 1] = c[1];
    rgba[o + 2] = c[2];
    rgba[o + 3] = 255;
  }
}

const out = process.argv[2] || resolve(HERE, 'out', 'brandmark-app.png');
writePng(out, W, H, rgba);
console.log(`rendered ${loops.length} subpaths -> ${out} (${W}x${H})`);
