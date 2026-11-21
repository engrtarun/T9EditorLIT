#!/usr/bin/env node
/**
 * Export contract audit — the cheap check that catches drift before CI does.
 *
 * The export feature is split across two lanes (Rust engine + Svelte UI) and
 * two documents (`EXPORT.md` §3 is the contract). The failures that hurt are
 * never type errors — they are:
 *
 *   1. a command the UI invokes but `generate_handler!` never registered
 *      (`cargo check` cannot see this; it fails only at runtime);
 *   2. an `ExportOptions` field that exists on one side and not the other
 *      (serde silently drops it, so the UI thinks it set a value and nothing
 *      happens);
 *   3. a new `ExportOptions` field with no `Default` entry (serde's `default`
 *      then builds a value the compiler accepts but the planner misreads).
 *
 * This script reads the actual source, compares the two sides, and prints the
 * drift. It is read-only and needs no build, no FFmpeg and no Tauri.
 *
 * Usage:
 *   node tools/export-contract-audit.mjs            # report, exit 0 on warnings
 *   node tools/export-contract-audit.mjs --strict   # exit 1 if anything is wrong
 *   node tools/export-contract-audit.mjs --json     # machine-readable
 *
 * Exit codes: 0 = clean (or warnings without --strict), 1 = drift, 2 = the
 * repo layout was not found.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".");
const STRICT = process.argv.includes("--strict");
const JSON_OUT = process.argv.includes("--json");

// The shipping app crate is `Clipchamp_Bunny/src-tauri`; it pulls the shared
// engine modules out of the root `src-tauri/src` with `#[path]` includes. The
// root `src-tauri/src/lib.rs` is the legacy sibling app — reading it here was
// the first version of this audit's bug (it reported 61 healthy commands as
// missing). Prefer the app crate, fall back to the root for old checkouts.
const APP_LIB_RS = join(ROOT, "Clipchamp_Bunny", "src-tauri", "src", "lib.rs");
const LIB_RS = existsSync(APP_LIB_RS) ? APP_LIB_RS : join(ROOT, "src-tauri", "src", "lib.rs");
const EXPORT_RS = join(ROOT, "src-tauri", "src", "export.rs");
const IPC_TS = join(ROOT, "Clipchamp_Bunny", "src", "lib", "ipc.ts");
const TYPES_TS = join(ROOT, "Clipchamp_Bunny", "src", "lib", "types.ts");
const UI_SRC = join(ROOT, "Clipchamp_Bunny", "src");
const EXPORT_MD = join(ROOT, "EXPORT.md");

if (!existsSync(LIB_RS) || !existsSync(EXPORT_RS) || !existsSync(IPC_TS)) {
  console.error(`export-contract-audit: not a T9EditorLIT checkout (looked in ${ROOT})`);
  process.exit(2);
}

const read = (path) => readFileSync(path, "utf8");

/** The body between the first `{` after `marker` and its matching `}`. */
function braceBlock(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) return null;
  const open = source.indexOf("{", at + marker.length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/** The body between the first `[` after `marker` and its matching `]`. */
function bracketBlock(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) return null;
  const open = source.indexOf("[", at + marker.length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/** `align_tolerance_ms` -> `alignToleranceMs` (the serde/TS spelling). */
function camel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** `pub struct Name { pub field: Type, ... }` -> field names. */
function rustStructFields(source, name) {
  const body = braceBlock(source, `pub struct ${name} `);
  if (!body) return null;
  return [...body.matchAll(/^\s*pub\s+([a-z0-9_]+)\s*:/gm)].map((m) => m[1]);
}

/** `export interface Name { field?: Type; ... }` -> field names. */
function tsInterfaceFields(source, name) {
  const body = braceBlock(source, `export interface ${name} `);
  if (!body) return null;
  return [...body.matchAll(/^\s*([A-Za-z0-9_]+)\??\s*:/gm)].map((m) => m[1]);
}

/** Every `invoke('name', ...)` / `invoke<T>('name', ...)` in the UI source. */
function uiInvocations(dir) {
  const found = new Map();
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".svelte-kit" || entry.name === "dist") {
        continue;
      }
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|svelte)$/.test(entry.name)) continue;
      // Comments mention commands too; a comment is not an invocation.
      const source = read(full)
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      for (const m of source.matchAll(/\binvoke\s*(?:<[\s\S]*?>)?\s*\(\s*['"]([a-z0-9_]+)['"]/g)) {
        if (!found.has(m[1])) found.set(m[1], []);
        found.get(m[1]).push(relative(ROOT, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(dir);
  return found;
}

const libRs = read(LIB_RS);
const exportRs = read(EXPORT_RS);
const ipcTs = read(IPC_TS);
const typesTs = existsSync(TYPES_TS) ? read(TYPES_TS) : "";
const exportMd = existsSync(EXPORT_MD) ? read(EXPORT_MD) : "";

const handlerBody = bracketBlock(libRs, "generate_handler!") ?? "";
const handlers = new Set(
  handlerBody
    .replace(/\/\/[^\n]*/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^.*::/, "")) // `browser::browser_show` -> `browser_show`
    .filter((s) => /^[a-z0-9_]+$/.test(s)),
);

const invocations = uiInvocations(UI_SRC);

const problems = [];
const warnings = [];
const progress = [];

// The UI is deliberately built ahead of the engine: a field or command listed
// in EXPORT.md §3 is allowed to exist on the TS side first. Anything *not* on
// this list is drift and fails the audit.
const PLANNED_FIELDS = [
  "fps",
  "codec",
  "container",
  "includeAudio",
  "crf",
  "videoBitrateKbps",
  "twoPass",
];
const PLANNED_COMMANDS = [
  "export_capabilities",
  "preflight_export",
  "list_export_history",
  "clear_export_history",
  "read_export_log",
];

// 1 ── command registration ────────────────────────────────────────────────
const invokedNotRegistered = [...invocations.keys()].filter((c) => !handlers.has(c)).sort();
const unexpectedInvocations = invokedNotRegistered.filter((c) => !PLANNED_COMMANDS.includes(c));
if (unexpectedInvocations.length) {
  problems.push(
    `invoked by the UI but missing from generate_handler!: ${unexpectedInvocations.join(", ")}`,
  );
}
const plannedNotRegistered = invokedNotRegistered.filter((c) => PLANNED_COMMANDS.includes(c));
if (plannedNotRegistered.length) {
  progress.push(
    `planned commands not registered yet: ${plannedNotRegistered.join(", ")} (EXPORT.md §3)`,
  );
}
const registeredNeverInvoked = [...handlers].filter((c) => !invocations.has(c)).sort();
if (registeredNeverInvoked.length) {
  warnings.push(
    `registered but never invoked from Clipchamp_Bunny/src (may be called elsewhere): ${registeredNeverInvoked.join(", ")}`,
  );
}

// 2 ── ExportOptions parity ────────────────────────────────────────────────
const rustOptions = rustStructFields(exportRs, "ExportOptions");
const tsOptions = tsInterfaceFields(ipcTs, "ExportOptions");
if (!rustOptions || !tsOptions) {
  problems.push("could not read ExportOptions from export.rs and/or ipc.ts");
} else {
  const rustCamel = new Set(rustOptions.map(camel));
  const tsSet = new Set(tsOptions);
  const rustOnly = [...rustCamel].filter((f) => !tsSet.has(f)).sort();
  const tsOnly = [...tsSet].filter((f) => !rustCamel.has(f)).sort();
  const tsOnlyUnexpected = tsOnly.filter((f) => !PLANNED_FIELDS.includes(f));
  if (rustOnly.length) problems.push(`ExportOptions only in Rust: ${rustOnly.join(", ")}`);
  if (tsOnlyUnexpected.length) {
    problems.push(`ExportOptions only in TS: ${tsOnlyUnexpected.join(", ")}`);
  }
  if (tsOnly.length > tsOnlyUnexpected.length) {
    progress.push(
      `planned options waiting on the engine: ${tsOnly
        .filter((f) => PLANNED_FIELDS.includes(f))
        .join(", ")}`,
    );
  }

  // 3 ── every Rust field must have a Default entry ───────────────────────
  const defaultBody = braceBlock(exportRs, "impl Default for ExportOptions") ?? "";
  const missingDefaults = rustOptions.filter((f) => !new RegExp(`\\b${f}\\s*:`).test(defaultBody));
  if (missingDefaults.length) {
    problems.push(`ExportOptions fields missing from Default: ${missingDefaults.join(", ")}`);
  }
}

// 4 ── planned §3 additions: progress, not failure ────────────────────────
const plannedRows = PLANNED_FIELDS.map((field) => ({
  field,
  rust: rustOptions?.some((f) => camel(f) === field) ?? false,
  ts: tsOptions?.includes(field) ?? false,
}));

// 5 ── history / preflight mirrors, when they start to exist ──────────────
const rustHistory = rustStructFields(exportRs, "ExportHistoryRow");
const tsHistory = tsInterfaceFields(typesTs, "ExportHistoryRow");
if (rustHistory || tsHistory) {
  if (rustHistory && !tsHistory) {
    problems.push("ExportHistoryRow exists in Rust but not in types.ts — the UI cannot render it");
  } else if (!rustHistory && tsHistory) {
    progress.push("ExportHistoryRow waiting on the engine (B1-1)");
  } else if (rustHistory && tsHistory) {
    const r = new Set(rustHistory.map(camel));
    const t = new Set(tsHistory);
    const rOnly = [...r].filter((f) => !t.has(f));
    const tOnly = [...t].filter((f) => !r.has(f));
    if (rOnly.length || tOnly.length) {
      problems.push(
        `ExportHistoryRow drift: rust-only=[${rOnly.join(", ")}] ts-only=[${tOnly.join(", ")}]`,
      );
    }
  }
}

const commandRows = PLANNED_COMMANDS.map((c) => ({
  command: c,
  registered: handlers.has(c),
  invoked: invocations.has(c),
}));

// 6 ── docs/contract cross-check: the §3 code block should not promise a
//      command that neither side mentions. Cheap, and catches a stale doc.
const contractCommands = [...exportMd.matchAll(/command:\s*([a-z0-9_]+)/g)].map((m) => m[1]);
const undocumented = [...handlers]
  .filter((h) => /export|history|preflight|log/i.test(h))
  .filter((h) => !contractCommands.includes(h) && !exportMd.includes(h));

const report = {
  root: ROOT,
  handlers: handlers.size,
  invocations: invocations.size,
  invokedNotRegistered,
  registeredNeverInvoked,
  exportOptions: { rust: rustOptions, ts: tsOptions },
  plannedRows,
  commandRows,
  problems,
  warnings,
  progress,
  undocumentedExportCommands: undocumented,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`export contract audit — ${ROOT}`);
  console.log(`  rust commands: ${handlers.size}   ui invoke sites: ${invocations.size}`);
  console.log("");
  for (const p of problems) console.log(`  FAIL  ${p}`);
  for (const w of warnings) console.log(`  warn  ${w}`);
  for (const p of progress) console.log(`  plan  ${p}`);
  if (!problems.length && !warnings.length) console.log("  OK    no drift found");

  console.log("");
  console.log("  planned §3 fields:");
  for (const row of plannedRows) {
    console.log(
      `    ${row.field.padEnd(18)} rust=${row.rust ? "yes" : "no "}  ts=${row.ts ? "yes" : "no "}`,
    );
  }
  console.log("");
  console.log("  planned commands:");
  for (const row of commandRows) {
    console.log(
      `    ${row.command.padEnd(22)} registered=${row.registered ? "yes" : "no "}  invoked=${row.invoked ? "yes" : "no "}`,
    );
  }
}

process.exit(problems.length && STRICT ? 1 : 0);
