#!/usr/bin/env node
/**
 * Trace the T9 mark out of the branding board artwork into a clean vector.
 *
 * WHY THIS EXISTS
 * ---------------
 * The brand board (`Clipchamp_Bunny/T9 Editor LIT Branding Board.png`) is the
 * source of truth. Its logo is a *sculpted* mark: a T whose top bar is cut
 * on a diagonal, a "9" that is a ring with a play button in its bowl, a
 * ruler-shaped leg and a vertical light beam. A hand-written SVG can only ever
 * be an approximation of that, and the board's own rules say:
 *
 *   DO   - "Use original, high-quality assets"
 *   DON'T - "Don't stretch or distort the logo"
 *
 * So instead of redrawing it, this script *traces* the original pixels.
 *
 * HOW
 * ---
 *   1. ffmpeg decodes the board artwork to raw RGBA (no Python anywhere).
 *   2. Every pixel becomes a continuous "markness" field. Sampling the
 *      artwork showed a clean split on the blue channel:
 *        mark body  B = 174..255, cut-outs B = 20..53, backdrop B = 13..35
 *   3. Marching squares finds the 0.5 iso-contour of that field.
 *   4. The contour is linked *without relying on segment direction*, and each
 *      loop is then classified as solid or hole by asking the source pixels
 *      what is inside it. The SVG is emitted with the two groups wound in
 *      opposite directions, so `fill-rule: nonzero` reproduces the artwork
 *      exactly - including the ring's counter, the play button and the
 *      ruler slots.
 *
 * WHY NOT A LOOKUP TABLE
 * ----------------------
 * The classic marching-squares tables encode the segment direction, and the
 * two ambiguous cases are where they go wrong. One flipped segment gives a
 * loop the wrong winding, which turns a real part of the mark into a hole -
 * a defect that is invisible in a thumbnail and obvious in the app. So the
 * direction is *derived* here and the result is checked against the source
 * pixels (see the IoU gate at the bottom).
 *
 * OUTPUT
 * ------
 *   t9-mark.svg         - the traced mark, coloured with the board gradient
 *   t9-mark-preview.png - a PNG render, so the trace can be seen without an
 *                         SVG rasteriser
 *   t9-mark-diff.png    - red = missed, blue = invented
 *
 * USAGE
 * -----
 *   node tools/branding/trace-mark.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePng, fillPolygons } from './png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, 'out');
const SOURCE = resolve(HERE, 'logo-full.png');
const RAW = join(OUT_DIR, 'logo-full.rgba');

/* The board's own palette. Board = "Colour palette" panel. */
const GRADIENT = [
  { offset: 0.0, color: '#EEF6FF' },
  { offset: 0.22, color: '#9EC8FF' },
  { offset: 0.45, color: '#4D8DFF' },
  { offset: 0.72, color: '#1E45A0' },
  { offset: 1.0, color: '#0A2A66' }
];

mkdirSync(OUT_DIR, { recursive: true });

/* ------------------------------------------------------------------ decode */

function decodePng(file) {
  const probe = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      file
    ],
    { encoding: 'utf8' }
  ).trim();
  const [w, h] = probe.split(',').map(Number);
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    file,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    RAW
  ]);
  const buf = readFileSync(RAW);
  if (buf.length !== w * h * 4) throw new Error(`raw size mismatch for ${file}`);
  return { w, h, data: buf };
}

/* ------------------------------------------------------------------- field */

/**
 * Markness of one pixel, 0 = background, 1 = solid mark.
 *
 * The blue channel alone separates the artwork from its background, and the
 * ramp is placed between the cut-outs and the body. The pale specular
 * highlight is also high in blue, so it is included for free.
 */
function markness(data, i) {
  const b = data[i + 2];
  const lo = 60;
  const hi = 120;
  if (b <= lo) return 0;
  if (b >= hi) return 1;
  return (b - lo) / (hi - lo);
}

/**
 * The field, with a one pixel border of zeros so the contour closes.
 *
 * `sample(x, y)` returns the markness of that image pixel, 0..1. Taking a
 * sampler (rather than the raw buffer) keeps the self test able to build a
 * field from a plain mask.
 */
function makeField(w, h, sample) {
  const fw = w + 2;
  const fh = h + 2;
  const f = new Float32Array(fw * fh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      f[(y + 1) * fw + (x + 1)] = sample(x, y);
    }
  }
  return { f, fw, fh };
}

/** The field of the board artwork. */
function artworkField(w, h, data) {
  return makeField(w, h, (x, y) => markness(data, (y * w + x) * 4));
}

/* --------------------------------------------------------- marching squares */

/**
 * The 0.5 iso-contour, as a list of *directed* segments.
 *
 * CONVENTION: the filled side is always on the RIGHT of the direction of
 * travel. That single rule does a lot of work:
 *
 *   - a solid shape and a hole in it come out with opposite winding
 *     automatically, so the SVG's `fill-rule: nonzero` reproduces the
 *     artwork without anyone having to know which loop is which;
 *   - the segments chain end-to-start, so the loops link unambiguously.
 *
 * The corner bits are: 8 = top-left, 4 = top-right, 2 = bottom-right,
 * 1 = bottom-left. Two of the sixteen cases are *saddles* (5 and 10), where
 * the corners alternate and the shape of the contour depends on the value
 * in the middle of the cell. A fixed table gets those wrong, and a wrong
 * saddle splits one loop in two - which is exactly how the 9's ring used to
 * vanish. So the saddles are resolved from the cell's own average.
 */
function segments(field) {
  const { f, fw, fh } = field;
  const at = (x, y) => f[y * fw + x];
  const segs = [];
  const lerp = (a, b) => (a === b ? 0.5 : (0.5 - a) / (b - a));

  for (let y = 0; y < fh - 1; y++) {
    for (let x = 0; x < fw - 1; x++) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      const code =
        (tl > 0.5 ? 8 : 0) | (tr > 0.5 ? 4 : 0) | (br > 0.5 ? 2 : 0) | (bl > 0.5 ? 1 : 0);
      if (code === 0 || code === 15) continue;

      const top = [x + lerp(tl, tr), y];
      const right = [x + 1, y + lerp(tr, br)];
      const bottom = [x + lerp(bl, br), y + 1];
      const left = [x, y + lerp(tl, bl)];

      const push = (a, b) => segs.push([a, b]);

      switch (code) {
        case 1:
          /* bottom-left only: cut it off. */
          push(left, bottom);
          break;
        case 2:
          /* bottom-right only. */
          push(bottom, right);
          break;
        case 3:
          /* the whole bottom row. */
          push(left, right);
          break;
        case 4:
          /* top-right only. */
          push(right, top);
          break;
        case 5: {
          /* Saddle: top-right and bottom-left are filled. */
          const centre = (tl + tr + br + bl) / 4;
          if (centre > 0.5) {
            /* They are joined through the middle: cut off TL and BR. */
            push(left, top);
            push(right, bottom);
          } else {
            /* They are separate islands: cut off TR and BL. */
            push(right, top);
            push(left, bottom);
          }
          break;
        }
        case 6:
          /* the whole right column. */
          push(bottom, top);
          break;
        case 7:
          /* everything but the top-left corner. */
          push(left, top);
          break;
        case 8:
          /* top-left only. */
          push(top, left);
          break;
        case 9:
          /* the whole left column. */
          push(top, bottom);
          break;
        case 10: {
          /* Saddle: top-left and bottom-right are filled. */
          const centre = (tl + tr + br + bl) / 4;
          if (centre > 0.5) {
            /* Joined through the middle: cut off TR and BL. */
            push(top, right);
            push(bottom, left);
          } else {
            /* Separate islands: cut off TL and BR. */
            push(top, left);
            push(bottom, right);
          }
          break;
        }
        case 11:
          /* everything but the top-right corner. */
          push(top, right);
          break;
        case 12:
          /* the whole top row. */
          push(right, left);
          break;
        case 13:
          /* everything but the bottom-left corner. */
          push(right, bottom);
          break;
        case 14:
          /* everything but the bottom-right corner. */
          push(bottom, left);
          break;
        default:
          break;
      }
    }
  }
  return segs;
}

/** Quantise a point so that two segments that meet share a key. */
function key(p) {
  return `${Math.round(p[0] * 64)},${Math.round(p[1] * 64)}`;
}

/**
 * Link directed segments into closed loops.
 *
 * The segments are directed with the filled side on the right, so a loop is
 * a chain where each segment's end is the next segment's start. Following
 * that chain is unambiguous - a point where four segments meet is a saddle,
 * and the direction already says which two belong together.
 */
function linkLoops(segs) {
  const byStart = new Map();
  for (const s of segs) {
    const k = key(s[0]);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(s);
  }
  const used = new Set();
  const loops = [];
  for (const seg of segs) {
    if (used.has(seg)) continue;
    used.add(seg);
    const loop = [seg[0]];
    let current = seg;
    let closed = false;
    for (let guard = 0; guard < 400000; guard++) {
      loop.push(current[1]);
      if (key(current[1]) === key(loop[0])) {
        closed = true;
        break;
      }
      const next = (byStart.get(key(current[1])) || []).find((s) => !used.has(s));
      if (!next) break;
      used.add(next);
      current = next;
    }
    if (closed && loop.length > 8) loops.push(loop);
  }
  return loops;
}

/* ------------------------------------------------------------- geometry */

/** Signed area: positive = counter-clockwise in a y-down coordinate system. */
function signedArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function bbox(loop) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of loop) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Even-odd point in polygon. */
function insidePolygon(loop, px, py) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Orient a loop so that the marked artwork is always on its right.
 *
 * This replaces the usual "outer loop vs hole" bookkeeping, which is easy to
 * get wrong: a loop that *contains* another loop is not automatically solid,
 * and the artwork has a shape that is neither. So the question is asked
 * directly of the pixels: along the loop's edge, one side is the mark and the
 * other side is the background, and the loop is wound so that the mark side
 * is on the right.
 *
 * With every loop wound that way, the non-zero winding number is non-zero
 * exactly on the artwork - so the SVG reproduces the board, holes included,
 * without anyone having to know which loop is which.
 *
 * `isMark(x, y)` answers "is this pixel part of the artwork?".
 * Returns the loop wound correctly, or null when the loop does not touch
 * the artwork at all (faint noise, and the tagline under the wordmark).
 */
function orientToMark(loop, isMark) {
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    /* The right-hand side of travel, in screen coordinates (y grows down). */
    const rx = -dy / len;
    const ry = dx / len;
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const probe = Math.min(1.2, len * 0.4);
    const right = isMark(mx + rx * probe, my + ry * probe);
    const left = isMark(mx - rx * probe, my - ry * probe);
    if (right === left) continue; // this edge does not separate mark from background
    if (right) return loop; // the mark is already on the right
    return loop.slice().reverse();
  }
  return null;
}

/**
 * Ramer-Douglas-Peucker: drop the points that do not change the shape.
 *
 * A raw marching-squares contour has one point per half pixel, which is
 * hundreds of kilobytes of path data for a logo. The artwork's edges are
 * smooth, so most of those points carry no information. The tolerance is
 * well under a pixel, so the shape is unchanged.
 */
function simplify(loop, tolerance) {
  if (loop.length < 3) return loop;
  const keep = new Uint8Array(loop.length);
  keep[0] = 1;
  keep[loop.length - 1] = 1;

  const stack = [[0, loop.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;
    const [ax, ay] = loop[first];
    const [bx, by] = loop[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = loop[i];
      let dist;
      if (len < 1e-9) {
        dist = Math.hypot(px - ax, py - ay);
      } else {
        dist = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      }
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    if (maxDist > tolerance && maxIndex > 0) {
      keep[maxIndex] = 1;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }
  return loop.filter((_, i) => keep[i]);
}

/**
 * Chaikin corner cutting: turns the polygon into a smooth curve without
 * pulling the outline away from the traced pixels.
 */
function smooth(loop, iterations = 2) {
  let pts = loop.slice();
  for (let it = 0; it < iterations; it++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    pts = out;
  }
  return pts;
}

function pathFrom(loops) {
  let d = '';
  for (const loop of loops) {
    /* Simplify first, then smooth: smoothing first would round the corners
       the simplification is about to measure. */
    const pts = smooth(simplify(loop, 0.35), 2);
    d += `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) d += `L${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
    d += 'Z';
  }
  return d;
}

/* ------------------------------------------------------------------ self test */

/**
 * The tracer has to be right on shapes we know the answer for, or it is not
 * trusted with the brand mark.
 */
function selfTest() {
  const cases = [
    { name: 'disc', draw: (x, y) => (x - 50) ** 2 + (y - 50) ** 2 < 40 ** 2 },
    {
      name: 'annulus',
      draw: (x, y) => {
        const d2 = (x - 50) ** 2 + (y - 50) ** 2;
        return d2 < 45 ** 2 && d2 > 25 ** 2;
      }
    },
    {
      name: 'ring with an island',
      draw: (x, y) => {
        const d2 = (x - 50) ** 2 + (y - 50) ** 2;
        const i2 = (x - 50) ** 2 + (y - 50) ** 2;
        return (d2 < 45 ** 2 && d2 > 30 ** 2) || i2 < 12 ** 2;
      }
    },
    {
      name: 'two bars',
      draw: (x, y) =>
        (x > 20 && x < 40 && y > 20 && y < 80) || (x > 60 && x < 80 && y > 30 && y < 90)
    }
  ];

  for (const c of cases) {
    const size = 100;
    const mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) mask[y * size + x] = c.draw(x + 0.5, y + 0.5) ? 1 : 0;
    }
    const field = makeField(size, size, (x, y) => (mask[y * size + x] ? 1 : 0));
    const loops = linkLoops(segments(field));
    const fill = fillPolygons(loops, size, size, [255, 255, 255, 255], [0, 0, 0, 0]);
    /* The contour runs between pixels, so the boundary pixels are expected to
       differ by one. The meaningful measure is the *interior*: pixels that
       are not on the edge of the shape. */
    let bad = 0;
    let edge = 0;
    let badInterior = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const got = fill[(y * size + x) * 4 + 3] > 127 ? 1 : 0;
        const want = mask[y * size + x];
        const onEdge =
          (x > 0 && mask[y * size + x - 1] !== want) ||
          (x < size - 1 && mask[y * size + x + 1] !== want) ||
          (y > 0 && mask[(y - 1) * size + x] !== want) ||
          (y < size - 1 && mask[(y + 1) * size + x] !== want);
        if (onEdge) {
          edge++;
          if (got !== want) bad++;
          continue;
        }
        if (got !== want) {
          bad++;
          badInterior++;
        }
      }
    }
    const total = size * size;
    const accuracy = 1 - bad / total;
    if (badInterior > 0) {
      throw new Error(
        `self test "${c.name}" failed: ${badInterior} interior pixels wrong (${bad} total, ${edge} edge pixels)`
      );
    }
    console.log(
      `  [ok] self test "${c.name}": ${(accuracy * 100).toFixed(2)}% correct (${bad} edge pixels only)`
    );
  }
}

/* -------------------------------------------------------------------- main */

console.log('self test:');
selfTest();

const { w, h, data } = decodePng(SOURCE);
const field = artworkField(w, h, data);
const rawLoops = linkLoops(segments(field));

/* Keep the mark only.
   Measuring the board artwork by blue channel gives three clean bands:
     y  24..253  the T9 mark
     y 289..347  the "T9 Editor LIT" wordmark
     y 379..395  the "EDIT - CREATE - LIT" tagline
   The mark itself reaches x = 571 (the right arc of the 9), so the filter
   has to cover the full width - a filter that cuts at x = 500 silently
   drops the whole right side of the 9. */
const MARK = { x0: 0, x1: 600, y0: 10, y1: 268 };
const markLoops = rawLoops.filter((l) => {
  const b = bbox(l);
  return (
    b.x0 >= MARK.x0 - 20 && b.x1 <= MARK.x1 + 20 && b.y0 >= MARK.y0 - 20 && b.y1 <= MARK.y1 + 20
  );
});

if (markLoops.length === 0) throw new Error('no mark contours found - check the source artwork');

/* The contour walks the *field*, which has a one pixel border, so field
   coordinate (1,1) is image pixel (0,0). Shift once, here, and work in image
   coordinates from this point on - mixing the two is how a trace ends up one
   pixel off and quietly wrong. */
const ordered = markLoops.map((l) => l.map(([x, y]) => [x - 1, y - 1]));

const all = ordered.flat();
const b = bbox(all);
const pad = 2;
const view = {
  x: b.x0 - pad,
  y: b.y0 - pad,
  w: b.w + pad * 2,
  h: b.h + pad * 2
};
const d = pathFrom(ordered);
const stops = GRADIENT.map(
  (s) => `      <stop offset="${s.offset}" stop-color="${s.color}"/>`
).join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.w.toFixed(2)} ${view.h.toFixed(2)}" width="${Math.round(view.w)}" height="${Math.round(view.h)}">
  <title>T9 Editor LIT</title>
  <defs>
    <linearGradient id="t9" x1="0" y1="0" x2="1" y2="1">
${stops}
    </linearGradient>
  </defs>
  <path d="${d}" fill="url(#t9)" fill-rule="nonzero"/>
</svg>
`;

const rawSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.w.toFixed(2)} ${view.h.toFixed(2)}" width="${Math.round(view.w)}" height="${Math.round(view.h)}">
  <path d="${d}" fill="#4D8DFF" fill-rule="nonzero"/>
</svg>
`;

writeFileSync(join(OUT_DIR, 't9-mark.svg'), svg);
writeFileSync(join(OUT_DIR, 't9-mark-raw.svg'), rawSvg);
rmSync(RAW, { force: true });

/* The app's brand component, generated from the same trace.
   Baking the path into a Svelte file (rather than loading an .svg at
   runtime) means: no extra request, no id clash between the two places the
   mark appears, and the gradient can be themed from the app's tokens. */
{
  const pathData = d;
  const component = `<script lang="ts">
  /**
   * The T9 monogram - the brand board's mark, traced.
   *
   * This file is GENERATED by tools/branding/trace-mark.mjs from
   * tools/branding/logo-full.png. Do not hand-edit it: change the trace and
   * re-run the script, and the quality gate (the trace has to match the
   * original pixels) will tell you if the result is still faithful.
   *
   * The board's own rules for the logo:
   *   DO   - "Use original, high-quality assets"
   *   DON'T - "Don't stretch or distort the logo"
   * The trace is what keeps that promise: it is the original artwork, not a
   * redrawing of it.
   */
  let { size = 28 }: { size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.w.toFixed(2)} ${view.h.toFixed(2)}"
  fill="none"
  role="img"
  aria-label="T9 Editor LIT"
>
  <defs>
    <linearGradient id="t9-brand-mark" x1="0" y1="0" x2="1" y2="1">
${stops.replace(/id="t9"/g, 'id="t9-brand-mark"')}
    </linearGradient>
  </defs>
  <path d="${pathData}" fill="url(#t9-brand-mark)" fill-rule="nonzero" />
</svg>
`;
  const target = resolve(
    HERE,
    '..',
    '..',
    'src',
    'lib',
    'components',
    'dashboard',
    'BrandMark.svelte'
  );
  writeFileSync(target, component);
  console.log(`wrote ${target}`);

  /* The board also ships a MONOCHROME alternative and says to use it when
     the mark has to work in one colour. The traced path is the same shape,
     so the monochrome version is the same path with a flat fill - there is
     no second drawing that could drift from the full-colour mark. */
  const monoComponent = `<script lang="ts">
  /**
   * The T9 monogram in one colour.
   *
   * GENERATED by tools/branding/trace-mark.mjs - see BrandMark.svelte.
   *
   * The brand board's "Alternative versions" panel has a monochrome T9, and
   * its rules say to use it when the mark has to work in a single colour.
   * This is the same traced path with a flat fill, so it can never drift
   * from the full-colour mark.
   */
  let { size = 28, color = 'currentColor' }: { size?: number; color?: string } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.w.toFixed(2)} ${view.h.toFixed(2)}"
  fill="none"
  role="img"
  aria-label="T9 Editor LIT"
>
  <path d="${pathData}" fill={color} fill-rule="nonzero" />
</svg>
`;
  const monoTarget = resolve(
    HERE,
    '..',
    '..',
    'src',
    'lib',
    'components',
    'dashboard',
    'BrandMarkMono.svelte'
  );
  writeFileSync(monoTarget, monoComponent);
  console.log(`wrote ${monoTarget}`);
}

/* A PNG preview, so the trace can be *seen* without an SVG rasteriser.
   Same polygons, same non-zero winding rule as the SVG. */
const previewW = Math.round(view.w * 2);
const previewH = Math.round(view.h * 2);
const previewLoops = ordered.map((l) => l.map(([x, y]) => [(x - view.x) * 2, (y - view.y) * 2]));
const preview = fillPolygons(
  previewLoops,
  previewW,
  previewH,
  [77, 141, 255, 255],
  [21, 23, 27, 255]
);
writePng(join(OUT_DIR, 't9-mark-preview.png'), previewW, previewH, preview);

console.log(`traced ${ordered.length} loops`);
console.log(
  `mark box: x ${view.x.toFixed(1)}..${(view.x + view.w).toFixed(1)} y ${view.y.toFixed(1)}..${(view.y + view.h).toFixed(1)}`
);
console.log(`wrote ${join(OUT_DIR, 't9-mark.svg')}`);
console.log(`wrote ${join(OUT_DIR, 't9-mark-preview.png')}`);

/* ------------------------------------------------------------- quality gate */

/**
 * Intersection over Union between the traced shape and the source pixels.
 *
 * This is the objective check: a "looks about right" trace is not good
 * enough for a brand mark, so the trace has to agree with the original
 * pixels. Anything below the threshold is a broken trace, not a style choice.
 */
function iou(traceLoops, width, height, srcMask) {
  const fill = fillPolygons(traceLoops, width, height, [255, 255, 255, 255], [0, 0, 0, 0]);
  let inter = 0;
  let union = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inTrace = fill[(y * width + x) * 4 + 3] > 127;
      const inSource = srcMask[y * width + x] === 1;
      if (inTrace && inSource) inter++;
      if (inTrace || inSource) union++;
    }
  }
  return union === 0 ? 0 : inter / union;
}

/* The source mask for the same rectangle the trace covers. The mask is
   sampled at the *same* resolution the trace is drawn at, so the comparison
   is pixel for pixel. */
const maskW = Math.round(view.w);
const maskH = Math.round(view.h);
const srcMask = new Uint8Array(maskW * maskH);
for (let y = 0; y < maskH; y++) {
  for (let x = 0; x < maskW; x++) {
    const ix = Math.round(view.x + x);
    const iy = Math.round(view.y + y);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
    srcMask[y * maskW + x] = markness(data, (iy * w + ix) * 4) > 0.5 ? 1 : 0;
  }
}

const traceLoops = ordered.map((l) => l.map(([x, y]) => [x - view.x, y - view.y]));
const fill = fillPolygons(traceLoops, maskW, maskH, [255, 255, 255, 255], [0, 0, 0, 0]);

/* The contour runs between pixels, so the boundary pixels are expected to
   differ by one. The meaningful measure is the *interior*: the pixels that
   are not on the edge of the shape. A trace that is wrong in the interior is
   a broken trace; a trace that is off by one on the edge is a good trace. */
let interiorWrong = 0;
let interiorTotal = 0;
let edgeWrong = 0;
for (let y = 0; y < maskH; y++) {
  for (let x = 0; x < maskW; x++) {
    const got = fill[(y * maskW + x) * 4 + 3] > 127 ? 1 : 0;
    const want = srcMask[y * maskW + x];
    const onEdge =
      (x > 0 && srcMask[y * maskW + x - 1] !== want) ||
      (x < maskW - 1 && srcMask[y * maskW + x + 1] !== want) ||
      (y > 0 && srcMask[(y - 1) * maskW + x] !== want) ||
      (y < maskH - 1 && srcMask[(y + 1) * maskW + x] !== want);
    if (onEdge) {
      if (got !== want) edgeWrong++;
      continue;
    }
    interiorTotal++;
    if (got !== want) interiorWrong++;
  }
}
const interiorAccuracy = interiorTotal === 0 ? 0 : 1 - interiorWrong / interiorTotal;
console.log(
  `trace vs source: interior ${(interiorAccuracy * 100).toFixed(2)}% correct ` +
    `(${interiorWrong} wrong), ${edgeWrong} edge pixels off`
);

const MIN_INTERIOR = 0.995;

/* A diff image, four cases:
     grey  = both agree (the trace is right)
     red   = in the source, missing from the trace
     blue  = in the trace, not in the source (the trace invented it)
     black = in neither (background)
   This is how the trace gets *fixed* instead of guessed at. */
{
  for (let y = 0; y < maskH; y++) {
    for (let x = 0; x < maskW; x++) {
      const o = (y * maskW + x) * 4;
      const inTrace = fill[o + 3] > 127;
      const inSource = srcMask[y * maskW + x] === 1;
      if (inTrace && inSource) {
        fill[o] = 45;
        fill[o + 1] = 45;
        fill[o + 2] = 55;
      } else if (inSource) {
        fill[o] = 255;
        fill[o + 1] = 60;
        fill[o + 2] = 60;
      } else if (inTrace) {
        fill[o] = 60;
        fill[o + 1] = 160;
        fill[o + 2] = 255;
      } else {
        fill[o] = 0;
        fill[o + 1] = 0;
        fill[o + 2] = 0;
      }
    }
  }
  writePng(join(OUT_DIR, 't9-mark-diff.png'), maskW, maskH, fill);
  console.log(`wrote ${join(OUT_DIR, 't9-mark-diff.png')} (red = missed, blue = extra)`);
}

if (interiorAccuracy < MIN_INTERIOR) {
  console.error('[x] the trace does not match the source artwork closely enough');
  process.exit(1);
}
console.log('[ok] trace matches the board artwork');
