#!/usr/bin/env node
/**
 * A tiny PNG writer + polygon rasteriser.
 *
 * WHY
 * ---
 * The branding work needs to *look* at a traced vector, and this repo has no
 * image library: Python is banned (AGENTS.md) and ffmpeg cannot decode SVG.
 * Node ships zlib, and a PNG is a zlib stream in a thin wrapper, so writing
 * one is cheaper than installing anything.
 *
 * It is also the honest way to check a trace: fill the traced polygons with
 * the same non-zero winding rule the SVG uses, and see the result.
 *
 * Exports:
 *   writePng(path, width, height, rgba)  - rgba is width*height*4 bytes
 *   fillPolygons(loops, width, height)    - non-zero winding, returns rgba
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

/* ------------------------------------------------------------------- crc32 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Write an 8-bit RGBA PNG. */
export function writePng(path, width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  writeFileSync(path, png);
  return path;
}

/* -------------------------------------------------------------- rasteriser */

/**
 * Fill polygons with the non-zero winding rule.
 *
 * The rule is the *SVG* rule, exactly, so a PNG rendered here and the SVG
 * shipped in the app show the same shape:
 *
 *   - cast a ray from the pixel to the right,
 *   - count the edges it crosses,
 *   - an edge that goes down (y grows) counts +1, one that goes up counts -1,
 *   - the pixel is inside when the total is not zero.
 *
 * Under that rule a clockwise-on-screen loop is "solid" and a
 * counter-clockwise one is a "hole", and a hole inside a solid loop cancels
 * it out - which is what the brand mark's ring, play button and ruler slots
 * need.
 *
 * `loops` is an array of loops; each loop is an array of [x, y] points.
 * Returns a Buffer of width*height*4 RGBA bytes.
 */
export function fillPolygons(
  loops,
  width,
  height,
  color = [77, 141, 255, 255],
  background = [0, 0, 0, 0]
) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = background[0];
    rgba[i * 4 + 1] = background[1];
    rgba[i * 4 + 2] = background[2];
    rgba[i * 4 + 3] = background[3];
  }

  /* Every edge that spans a scanline, kept in one flat list. */
  const edges = [];
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      if (a[1] === b[1]) continue;
      edges.push({ y0: a[1], y1: b[1], x0: a[0], x1: b[0], down: b[1] > a[1] });
    }
  }

  for (let py = 0; py < height; py++) {
    const y = py + 0.5;
    const crossings = [];
    for (const e of edges) {
      const lo = Math.min(e.y0, e.y1);
      const hi = Math.max(e.y0, e.y1);
      if (y < lo || y >= hi) continue;
      const t = (y - e.y0) / (e.y1 - e.y0);
      crossings.push({ x: e.x0 + t * (e.x1 - e.x0), sign: e.down ? 1 : -1 });
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a.x - b.x);

    /* Suffix sums: for a pixel in the span between crossings[i] and
       crossings[i+1], the ray to the right crosses every crossing from
       i+1 onwards, so that is the winding number. */
    const suffix = new Array(crossings.length + 1).fill(0);
    for (let i = crossings.length - 1; i >= 0; i--) {
      suffix[i] = suffix[i + 1] + crossings[i].sign;
    }

    for (let i = 0; i + 1 < crossings.length; i++) {
      if (suffix[i + 1] === 0) continue;
      const xa = crossings[i].x;
      const xb = crossings[i + 1].x;
      const from = Math.max(0, Math.floor(xa - 0.5) + 1);
      const to = Math.min(width - 1, Math.ceil(xb - 0.5) - 1);
      for (let px = from; px <= to; px++) {
        const o = (py * width + px) * 4;
        rgba[o] = color[0];
        rgba[o + 1] = color[1];
        rgba[o + 2] = color[2];
        rgba[o + 3] = color[3];
      }
    }
  }
  return rgba;
}
