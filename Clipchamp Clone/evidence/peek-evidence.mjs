// Pull scalar metadata out of the large REA Evidence JSON without holding the
// whole document in memory: reads only a short prefix and suffix.
import { openSync, readSync, closeSync } from "node:fs";
import { stat } from "node:fs/promises";

const FILE =
  "C:\\Users\\pocot\\Music\\T9EditorLIT\\Clipchamp Clone\\evidence\\rea-js-analysis.json";

const st = await stat(FILE);
const HEAD = 6000;
const TAIL = 40000;

const fd = openSync(FILE, "r");
const readAt = (pos, len) => {
  const b = Buffer.alloc(len);
  readSync(fd, b, 0, len, pos);
  return b.toString("utf8");
};

const head = readAt(0, HEAD);
const tail = readAt(Math.max(0, st.size - TAIL), TAIL);
closeSync(fd);

console.log("file MB:", (st.size / 1048576).toFixed(1));
console.log("\n===== HEAD (first 1200 chars) =====");
console.log(head.slice(0, 1200));
console.log("\n===== TAIL (last 2200 chars) =====");
console.log(tail.slice(-2200));

console.log("\n===== KEY OCCURRENCES IN SAMPLED REGIONS =====");
for (const key of [
  "evidence_id",
  "provider",
  "confidence",
  "authority",
  "limitations",
  "operation",
]) {
  const count = (src) => (src.match(new RegExp(`"${key}":`, "g")) ?? []).length;
  console.log(`${key}: head=${count(head)} tail=${count(tail)}`);
}
