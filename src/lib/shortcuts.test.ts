import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";

/**
 * Registry completeness.
 *
 * `BINDINGS` is the single source of truth for the key matcher *and* the
 * cheat sheet, which is only a guarantee if the two halves stay in step: an
 * entry with no `shortcuts.bind(id, …)` anywhere is a key the sheet documents
 * but the app silently ignores (Ctrl + / shipped exactly like that, and so did
 * eleven others), while a bind with no table entry is a key nothing can look
 * up.
 *
 * These tests read the sources instead of importing them: `shortcuts.svelte.ts`
 * uses Svelte runes, which are compile-time syntax and do not exist at runtime
 * under `node --test`.
 */

/** The `src/` tree, one level up from this file. */
const SRC = join(import.meta.dirname, "..");
const STORE = join(SRC, "lib", "stores", "shortcuts.svelte.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      // Tests scan these same sources; letting them scan each other (or their
      // own regex literals and comments) would report fake bindings.
    } else if (/\.(svelte|ts)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

const storeSource = readFileSync(STORE, "utf8");

/** Every `def("id", …)` in table order. */
const declared: string[] = [...storeSource.matchAll(/def\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);

/** Ids whose own `def(…)` call carries `planned: true`. */
const planned = new Set<string>();
{
  const marks = [...storeSource.matchAll(/def\(\s*"([A-Za-z0-9_]+)"/g)];
  marks.forEach((m, i) => {
    const slice = storeSource.slice(m.index ?? 0, marks[i + 1]?.index ?? storeSource.length);
    if (slice.includes("planned: true")) planned.add(m[1]);
  });
}

/** `id → file` for every `shortcuts.bind("id", …)` in the tree. */
const bound = new Map<string, string>();
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/shortcuts\.bind\(\s*"([A-Za-z0-9_]+)"/g)) {
    if (!bound.has(m[1])) bound.set(m[1], basename(file));
  }
}

test("BINDINGS declares unique ids", () => {
  const dupes = declared.filter((id, i) => declared.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate ids in BINDINGS: ${dupes.join(", ")}`);
});

test("the table is not empty (the parse above must actually see it)", () => {
  assert.ok(declared.length >= 30, `only parsed ${declared.length} ids — the regex drifted`);
});

test("every key the app binds is documented in BINDINGS", () => {
  const orphans = [...bound.keys()].filter((id) => !declared.includes(id));
  assert.deepEqual(orphans, [], `bound but undocumented: ${orphans.join(", ")}`);
});

test("every documented key is bound, or explicitly marked planned", () => {
  const dead = declared.filter((id) => !bound.has(id) && !planned.has(id));
  assert.deepEqual(dead, [], `listed in the cheat sheet but pressable nowhere: ${dead.join(", ")}`);
});

test("planned keys are not bound (a planned key must not half-work)", () => {
  const wired = [...planned].filter((id) => bound.has(id));
  assert.deepEqual(wired, [], `marked planned yet bound: ${wired.join(", ")}`);
});

test("the shell owns the only window keydown listener", () => {
  const privateListeners = walk(SRC)
    .filter((f) => f.endsWith(".svelte"))
    .filter((f) => /addEventListener\(\s*["']keydown["']/.test(readFileSync(f, "utf8")))
    .map((f) => basename(f));
  assert.deepEqual(
    privateListeners,
    [],
    `components must register with the shortcuts store instead: ${privateListeners.join(", ")}`,
  );

  // Two exceptions are legitimate window-level handlers: the dispatcher itself,
  // and CcMenu's outside-click/Escape pair for popovers.
  const allowed = new Set(["ShortcutsLayer.svelte", "CcMenu.svelte"]);
  const windowHandlers = walk(SRC)
    .filter((f) => f.endsWith(".svelte"))
    .filter((f) => /<svelte:window[^>]*onkeydown/.test(readFileSync(f, "utf8")))
    .map((f) => basename(f))
    .filter((name) => !allowed.has(name));
  assert.deepEqual(windowHandlers, [], `unexpected window keydown: ${windowHandlers.join(", ")}`);
});
