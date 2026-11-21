#!/usr/bin/env bun
/**
 * WH Skill Champion — recompute the banner from the vault's own usage log.
 *
 * Run with bun (the vault CLI is a bun script too):
 *   bun tools/wh-champion.mjs
 *
 * The record in docs/WH_SKILL_CHAMPION.md is a snapshot. This script is the
 * source of truth: no numbers are hard-coded here, so a new session can verify
 * the claim in one command instead of trusting a doc written weeks ago.
 */

import { Database } from "bun:sqlite";

const DB = process.env.T9_VAULT_DB ?? "C:/Users/pocot/.opencode/vault/vault.db";
const db = new Database(DB, { readonly: true });

const owners = db
  .query(
    `select coalesce(nullif(u.owner,''),'(unattributed)') owner,
            count(*) actions,
            count(distinct i.name) skills
     from usage_log u left join items i on i.id = u.item_id
     where u.action in ('on','pick','cat','brief')
     group by owner
     order by skills desc, actions desc`,
  )
  .all();

const named = owners.filter((r) => r.owner !== "(unattributed)");
const champ = named[0] ?? null;
const unattributed = owners.find((r) => r.owner === "(unattributed)");

const topSkills = db
  .query(
    `select i.name, i.use_count from items i
     where i.kind='skill' and i.use_count>0
     order by i.use_count desc limit 8`,
  )
  .all();

const bar = "═".repeat(70);
const line = (s) => `║${s.padEnd(70)}║`;
console.log(`╔${bar}╗`);
console.log(line("  WH SKILL CHAMPION — BANNER RECORD"));
console.log(`╠${bar}╣`);
if (champ) {
  console.log(
    line(
      `  ${champ.owner.padEnd(24)} ${String(champ.skills).padStart(2)} skills / ${String(champ.actions).padStart(2)} actions`,
    ),
  );
} else {
  console.log(line("  no attributed skill use yet"));
}
console.log(`╚${bar}╝`);

console.log("\nleaderboard (attributed sessions):");
for (const [i, r] of named.entries()) {
  console.log(
    `  ${i + 1}. ${r.owner.padEnd(24)} ${String(r.skills).padStart(2)} skills  ${String(r.actions).padStart(2)} actions`,
  );
}
if (unattributed) {
  console.log(
    `  —  ${"(unattributed)".padEnd(24)} ${String(unattributed.skills).padStart(2)} skills  ${String(unattributed.actions).padStart(2)} actions  (older logs / no --owner)`,
  );
}

console.log("\nmost-used skills (all sessions):");
for (const s of topSkills) {
  console.log(`  ${s.name.padEnd(32)} ${s.use_count}`);
}

console.log(`\nsource: ${DB}`);
console.log("method: distinct items in usage_log joined by item_id, actions on|pick|cat|brief");
