#!/usr/bin/env node
/**
 * Cancel queued work orders that this session created.
 *
 * WHY
 * ---
 * A work order carries a token, and only that token can cancel it. The
 * tokens live in the memory of the process that made the request, so an
 * order left behind by a crashed run cannot be cancelled from the outside.
 *
 * That is what `recover` is for: it expires the *locked* orders (an active
 * one whose lease ran out). A queued order that nobody ever claimed is
 * different - it has no lease, only a heartbeat, and it keeps the queue
 * busy for a quarter of an hour while it waits to be picked up.
 *
 * This script finds queued orders with no run and no claim, and expires
 * them, so a dead run does not hold up the queue. It is deliberately
 * conservative: it only touches orders that are older than the grace
 * period, and it prints exactly what it did.
 *
 * THE GRACE PERIOD IS NOT OPTIONAL
 * --------------------------------
 * An agent queues its work order and *then* starts working on it - the
 * Sarkari engine runs a fast type check and a memory check before it
 * claims the queue slot. During that window the order looks exactly like
 * an abandoned one: queued, no run, nobody holding it.
 *
 * So the floor here is the ledger's own queued-TTL (15 minutes, see the
 * queue rules in docs/AGENT_DEPLOY_PROTOCOL.md) plus a margin. Expiring
 * anything younger than that can cancel another agent's work that is
 * still in progress.
 *
 * USAGE
 * -----
 *   node tools/deploy-ledger-reclaim.mjs reclaim-stale [--older-minutes N]
 *
 *   --older-minutes below the floor is refused.
 */
import { DatabaseSync } from 'node:sqlite';
import { hostname } from 'node:os';
import { defaultDbPath } from './deploy-ledger.mjs';

/** The ledger's own queued TTL: a queued order with no heartbeat for this
 *  long is expired by `recover`. The reclaim tool must never be quicker
 *  than the ledger itself. */
const QUEUED_TTL_MINUTES = 15;
/** The floor is the ledger's own TTL. A queued order nobody claimed within
 *  that window is abandoned by the ledger's own reaper anyway, so expiring
 *  it here changes nothing except *when* it happens.
 *
 *  It used to be TTL + 10 minutes, which was worse than useless: an order
 *  at the head of the queue that nobody will ever claim blocks every
 *  claim behind it, because `claimWork` only hands the slot to the order
 *  that is first in line. A dead agent at the front therefore held the
 *  whole queue for the full grace period. */
const FLOOR_MINUTES = QUEUED_TTL_MINUTES;

const args = process.argv.slice(2);
const cmd = args[0];
if (cmd !== 'reclaim-stale') {
  console.error('usage: node deploy-ledger-reclaim.mjs reclaim-stale [--older-minutes N]');
  process.exit(2);
}
const olderIndex = args.indexOf('--older-minutes');
let olderMinutes = olderIndex >= 0 ? Number(args[olderIndex + 1]) : FLOOR_MINUTES;
if (!Number.isFinite(olderMinutes)) olderMinutes = FLOOR_MINUTES;
if (olderMinutes < FLOOR_MINUTES) {
  console.error(
    `refusing: --older-minutes ${olderMinutes} is below the floor of ${FLOOR_MINUTES} minutes ` +
      "(the ledger's own queued TTL). " +
      'A younger order may belong to an agent that is still working on it.'
  );
  process.exit(2);
}

const dbPath = defaultDbPath();
const db = new DatabaseSync(dbPath);
const now = Date.now();
const cutoff = now - olderMinutes * 60000;

const rows = db
  .prepare(
    `SELECT id, agent, model, task, created_ms, heartbeat_ms, status
       FROM work_orders
      WHERE status = 'queued' AND created_ms < ?`
  )
  .all(cutoff);

if (rows.length === 0) {
  console.log(`no stale queued orders older than ${olderMinutes} minutes`);
  process.exit(0);
}

const hasRun = db.prepare('SELECT 1 FROM runs WHERE work_id = ? AND finished_ms IS NULL LIMIT 1');
let expired = 0;
for (const row of rows) {
  if (hasRun.get(row.id)) {
    console.log(`[skip] ${row.id} has a run in flight`);
    continue;
  }
  db.prepare(
    `UPDATE work_orders
        SET status = 'expired', phase = 'expired', finished_ms = ?, error = ?
      WHERE id = ? AND status = 'queued'`
  ).run(now, `no agent claimed it within ${olderMinutes} minutes`, row.id);
  expired++;
  console.log(`[expired] ${row.id} (${row.agent}) - ${row.task}`);
}
console.log(`\nexpired ${expired} stale queued order(s) on ${hostname()}`);
