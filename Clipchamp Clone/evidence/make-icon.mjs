// Generate `src-tauri/icons/icon.ico` without an image toolchain.
//
// tauri-build requires this file on Windows to emit the resource section, so it
// must exist for `cargo build`/`cargo test` to run at all. Emitting a
// hand-rolled 32x32 32-bit ICO keeps the repo free of binary blobs that nobody
// can regenerate, and gives `tauri icon` something real to overwrite later.
//
// Run: node evidence/make-icon.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src-tauri", "icons", "icon.ico");

const W = 32;
const H = 32;

// Brand-ish indigo, matching --color-accent in src/app.css.
const BG = [0x8b, 0x5c, 0xf6, 0xff]; // BGRA
const FG = [0xf5, 0xf3, 0xff, 0xff]; // BGRA

/** Rounded-square mask with a play-triangle cut out, so the icon reads as a video app. */
function pixel(x, y) {
  const r = 6; // corner radius
  const inset = 1;

  const insideRounded =
    x >= inset &&
    y >= inset &&
    x < W - inset &&
    y < H - inset &&
    (() => {
      const cx = Math.min(Math.max(x, inset + r), W - inset - r);
      const cy = Math.min(Math.max(y, inset + r), H - inset - r);
      return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    })();

  if (!insideRounded) return [0, 0, 0, 0];

  // Play triangle, centred.
  const tx = x - 12;
  const ty = y - 10;
  if (tx >= 0 && tx <= 9 && Math.abs(ty) <= (tx * 5) / 9) return FG;

  return BG;
}

const xor = Buffer.alloc(W * H * 4);
for (let row = 0; row < H; row++) {
  // BMP rows are bottom-up.
  const y = H - 1 - row;
  for (let x = 0; x < W; x++) {
    const [b, g, r, a] = pixel(x, y);
    const o = (row * W + x) * 4;
    xor[o] = b;
    xor[o + 1] = g;
    xor[o + 2] = r;
    xor[o + 3] = a;
  }
}

// AND mask: 1bpp, rows padded to 4 bytes (32px = exactly 4 bytes here).
const and = Buffer.alloc((W / 8) * H, 0);
for (let row = 0; row < H; row++) {
  const y = H - 1 - row;
  for (let x = 0; x < W; x++) {
    if (pixel(x, y)[3] === 0) and[row * (W / 8) + x / 8] |= 0x80 >> (x % 8);
  }
}

const dib = Buffer.alloc(40);
dib.writeUInt32LE(40, 0); // header size
dib.writeInt32LE(W, 4);
dib.writeInt32LE(H * 2, 8); // height counts XOR + AND
dib.writeUInt16LE(1, 12); // planes
dib.writeUInt16LE(32, 14); // bits per pixel
dib.writeUInt32LE(0, 16); // BI_RGB
dib.writeUInt32LE(xor.length + and.length, 20);
dib.writeInt32LE(0, 24); // x ppm
dib.writeInt32LE(0, 28); // y ppm
dib.writeUInt32LE(0, 32); // clrUsed
dib.writeUInt32LE(0, 36); // clrImportant

const image = Buffer.concat([dib, xor, and]);

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // 1 = icon
dir.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(W, 0);
entry.writeUInt8(H, 1);
entry.writeUInt8(0, 2); // palette size
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bit count
entry.writeUInt32LE(image.length, 8);
entry.writeUInt32LE(22, 12); // image offset

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([dir, entry, image]));

console.log(`wrote ${OUT}`);
console.log(`  ${W}x${H}, 32-bit, ${image.length + 22} bytes`);
