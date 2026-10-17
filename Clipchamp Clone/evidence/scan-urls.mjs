// Recover the URL inventory from the Chromium cache index files.
//
// These strings are TLS/CRL artefacts plus real application endpoints. They are
// recovered from `index` / `data_2` / `data_3`, so they are *evidence of what
// was cached*, not proof that a request was made or succeeded.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CACHE_DIR =
  "C:\\Users\\pocot\\AppData\\Local\\Packages\\Clipchamp.Clipchamp_yxz26nhyzhsrt\\LocalState\\EBWebView\\Default\\Cache\\Cache_Data";
const OUT =
  "C:\\Users\\pocot\\Music\\T9EditorLIT\\Clipchamp Clone\\evidence\\cache-url-inventory.json";

const found = new Map();

for (const name of ["index", "data_2", "data_3"]) {
  let buf;
  try {
    buf = readFileSync(join(CACHE_DIR, name));
  } catch {
    continue; // index file absent for this profile
  }

  let run = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) {
      run.push(b);
      if (run.length > 4096) run.shift();
      continue;
    }
    if (run.length >= 12) {
      const s = Buffer.from(run).toString("latin1");
      for (const u of s.match(/https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g) ?? []) {
        found.set(u, (found.get(u) ?? 0) + 1);
      }
    }
    run = [];
  }
}

const urls = [...found.keys()].sort();

// Flag the entries that are certificate/OCSP plumbing rather than app traffic,
// so the findings doc does not have to eyeball them every time.
const isTlsNoise = (u) =>
  /\.(?:crl|crt)0?$/.test(u) ||
  /pki\.goog|pkiops\.microsoft\.com|digicert\.com|digicert\.com/.test(u) ||
  /cacerts\.digicert/.test(u);

const application = urls.filter((u) => !isTlsNoise(u));
const tls = urls.filter(isTlsNoise);

writeFileSync(
  OUT,
  JSON.stringify(
    {
      provenance:
        "ASCII-run scan of Chromium simple-cache index files in the Clipchamp WebView2 profile. " +
        "Presence indicates a cached entry, not an observed request or a successful response.",
      source: CACHE_DIR,
      counts: { total: urls.length, application: application.length, tlsNoise: tls.length },
      application,
      tlsNoise: tls,
    },
    null,
    2,
  ),
);

console.log(`total: ${urls.length}`);
console.log(`  application-ish: ${application.length}`);
console.log(`  TLS/CRL noise  : ${tls.length}`);
for (const u of application) console.log(`  ${u}`);
