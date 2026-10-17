// Feature-map scanner: counts editor-domain keyword hits across the extracted
// Clipchamp JS tree and records a short, stable-context sample per keyword.
//
// Reads one file at a time and never retains more than a bounded context
// buffer, so peak memory stays independent of total bundle size.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "C:\\Users\\pocot\\Music\\T9EditorLIT\\Clipchamp Clone\\evidence\\web-assets";
const OUT = "C:\\Users\\pocot\\Music\\T9EditorLIT\\Clipchamp Clone\\evidence\\feature-map.json";

// Grouped like a video editor feature inventory rather than a flat word list.
const GROUPS = {
  "timeline & tracks": [
    "timeline",
    "playhead",
    "scrub",
    "trackOrder",
    "clipTrack",
    "marker",
    "keyframe",
    "ripple",
  ],
  trimming: ["trim", "splitClip", "splitPoint", "trimStart", "trimEnd", "inPoint", "outPoint"],
  transitions: ["transition", "crossfade", "dissolve", "wipeTransition", "fadeIn", "fadeOut"],
  filters: [
    "filter",
    "lut",
    "colorGrade",
    "brightness",
    "contrast",
    "saturation",
    "temperature",
    "vignette",
  ],
  captions: ["caption", "subtitle", "transcript", "autoCaption", "speechToText", "closedCaption"],
  audio: [
    "audioTrack",
    "waveform",
    "volume",
    "normalizeAudio",
    "noiseRemoval",
    "musicBed",
    "ducking",
  ],
  effects: [
    "overlay",
    "sticker",
    "element",
    "background",
    "textEffect",
    "animation",
    "stickerPack",
  ],
  text: ["textLayer", "textStyle", "fontFamily", "textAlign", "headline", "titleCard"],
  export: [
    "exportVideo",
    "resolution",
    "bitrate",
    "frameRate",
    "codec",
    "mp4",
    "mov",
    "webm",
    "render",
  ],
  media: ["thumbnail", "proxy", "waveformData", "mediaDuration", "aspectRatio", "sourceFile"],
  storage: ["cloudStorage", "oneDrive", "projectAutosave", "draft", "assetLibrary"],
  ai: ["aiClip", "autoCut", "silenceDetect", "fillerWord", "removeBackground", "autoCaption"],
  collab: ["comment", "shareLink", "coauthor", "reviewMode", "versionHistory"],
};

// Per-keyword accounting.
const stats = new Map();
for (const [group, words] of Object.entries(GROUPS)) {
  for (const w of words) stats.set(w, { group, count: 0, files: new Set(), sample: null });
}

const files = readdirSync(SRC).filter((f) => f.endsWith(".js"));
const perFile = [];

for (const f of files) {
  const text = readFileSync(join(SRC, f), "latin1");
  const hit = [];
  for (const [w, s] of stats) {
    let n = 0;
    let at = text.indexOf(w);
    let first = -1;
    while (at !== -1) {
      n++;
      if (first === -1) first = at;
      at = text.indexOf(w, at + w.length);
    }
    if (n > 0) {
      s.count += n;
      s.files.add(f);
      if (s.sample === null) {
        const a = Math.max(0, first - 70);
        s.sample = text.slice(a, first + w.length + 90).replace(/\s+/g, " ");
      }
      hit.push([w, n]);
    }
  }
  if (hit.length)
    perFile.push({ file: f, kb: Math.round(text.length / 1024), hits: Object.fromEntries(hit) });
}

const inventory = [...stats.entries()]
  .map(([word, s]) => ({
    keyword: word,
    group: s.group,
    occurrences: s.count,
    files: s.files.size,
    sample: s.sample,
  }))
  .filter((x) => x.occurrences > 0)
  .sort((a, b) => b.occurrences - a.occurrences);

const byGroup = {};
for (const x of inventory) {
  byGroup[x.group] ??= { keywords: 0, occurrences: 0, top: [] };
  byGroup[x.group].keywords++;
  byGroup[x.group].occurrences += x.occurrences;
  byGroup[x.group].top.push([x.keyword, x.occurrences]);
}
for (const g of Object.values(byGroup)) g.top.sort((a, b) => b[1] - a[1]);

writeFileSync(
  OUT,
  JSON.stringify(
    {
      source: SRC,
      jsFiles: files.length,
      totals: {
        keywords: inventory.length,
        occurrences: inventory.reduce((a, b) => a + b.occurrences, 0),
      },
      byGroup,
      inventory,
      perFile,
    },
    null,
    2,
  ),
);

console.log(`js files scanned : ${files.length}`);
console.log(`keywords found  : ${inventory.length}`);
console.log(`total occurrences: ${inventory.reduce((a, b) => a + b.occurrences, 0)}`);
console.log("groups:");
for (const [g, v] of Object.entries(byGroup))
  console.log(`  ${g.padEnd(18)} ${v.keywords} kw  ${v.occurrences} hits`);
