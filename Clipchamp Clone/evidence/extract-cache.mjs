// Extract Clipchamp WebView2 Chromium simple-cache entries into a JS/CSS/image tree.
//
// Observed encoding chain in this profile: gzip (cache wrapper) -> brotli
// (server content-encoding) -> raw bytes. Brotli has no magic number, so it is
// only accepted when decompressing produces content that sniffs as real text.
//
// Streams one entry at a time; nothing accumulates in memory across entries.
import { readFileSync } from "node:fs";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readdir, stat, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";

const CACHE_DIR =
  "C:\\Users\\pocot\\AppData\\Local\\Packages\\Clipchamp.Clipchamp_yxz26nhyzhsrt\\LocalState\\EBWebView\\Default\\Cache\\Cache_Data";
const OUT = "C:\\Users\\pocot\\Music\\T9EditorLIT\\Clipchamp Clone\\evidence\\web-assets";

const isGzip = (b) => b[0] === 0x1f && b[1] === 0x8b;

function sniff(buf) {
  if (buf.length < 4) return { ext: "bin", kind: "other" };
  const m = (sig) => buf.slice(0, sig.length).equals(Buffer.from(sig));
  if (m([0xff, 0xd8, 0xff])) return { ext: "jpg", kind: "image" };
  if (m([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", kind: "image" };
  if (m([0x77, 0x45, 0x42, 0x50])) return { ext: "webp", kind: "image" };
  if (m([0x77, 0x4f, 0x46, 0x32])) return { ext: "woff2", kind: "font" };
  if (m([0x77, 0x4f, 0x46, 0x00])) return { ext: "woff", kind: "font" };
  const s = buf
    .toString("latin1")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (/^<!doctype html|^<html/i.test(s)) return { ext: "html", kind: "html" };
  if (/^<\?xml/i.test(s)) return { ext: "xml", kind: "xml" };
  if (/^[{[]/.test(s)) return { ext: "json", kind: "json" };
  if (/\b(?:function|=>|\bconst\b|\bvar\b|\bimport\b|\bexport\b|\bclass\b)\b|\/\*/.test(s))
    return { ext: "js", kind: "js" };
  if (/^[.#@A-Za-z*][^{]*\{/.test(s)) return { ext: "css", kind: "css" };
  return { ext: "bin", kind: "other" };
}

/** Strip gzip, then brotli only when it yields content that sniffs as text. */
function unwrap(buf) {
  const layers = [];
  let cur = buf;

  if (isGzip(cur)) {
    try {
      cur = gunzipSync(cur, { finishFlush: 1 });
      layers.push("gzip");
    } catch (e) {
      return { data: buf, layers, error: `gunzip: ${e.message}` };
    }
  }

  if (sniff(cur).kind === "other") {
    try {
      const next = brotliDecompressSync(cur);
      if (sniff(next).kind !== "other") {
        cur = next;
        layers.push("brotli");
      }
    } catch {
      /* not brotli - keep current bytes */
    }
  }

  return { data: cur, layers };
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const streams = (await readdir(CACHE_DIR)).filter((f) => /^f_[0-9a-f]+$/i.test(f)).sort();
const manifest = [];
const seen = new Map();
let total = 0;

for (const name of streams) {
  const src = join(CACHE_DIR, name);
  const st = await stat(src);
  const { data, layers, error } = unwrap(readFileSync(src));
  const { ext, kind } = sniff(data.subarray(0, 65536));
  const sha = createHash("sha256").update(data).digest("hex");

  if (seen.has(sha)) {
    manifest.push({
      stream: name,
      status: "duplicate",
      duplicateOf: seen.get(sha),
      cachedBytes: st.size,
      decodedBytes: data.length,
    });
    continue;
  }

  const outName = `${name.slice(2)}_${sha.slice(0, 8)}.${ext}`;
  await writeFile(join(OUT, outName), data);
  seen.set(sha, outName);
  total += data.length;
  manifest.push({
    stream: name,
    file: outName,
    kind,
    layers,
    cachedBytes: st.size,
    decodedBytes: data.length,
    ...(error ? { error } : {}),
    sha256: sha,
  });
}

await writeFile(join(OUT, "..", "manifest.json"), JSON.stringify(manifest, null, 2));

const byKind = {};
for (const m of manifest) if (m.kind) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;

console.log(`streams scanned : ${streams.length}`);
console.log(`unique artifacts: ${seen.size}  (${(total / 1048576).toFixed(1)} MB)`);
console.log(`duplicates      : ${manifest.filter((m) => m.status === "duplicate").length}`);
console.log("by kind         :", byKind);
