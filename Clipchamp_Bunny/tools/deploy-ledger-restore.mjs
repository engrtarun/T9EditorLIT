#!/usr/bin/env node
/**
 * Put a work order back, or release one that is stuck.
 *
 * WHY
 * ---
 * `reclaim-stale` expires queued orders that nobody claimed. It is
 * deliberately slow about it, but a mistake is still possible - and the
 * cost of a wrong expiry is high: the agent that owned the order loses
 * its place in the queue and its deploy may be half done.
 *
 * The other failure is the mirror image: an order that was *claimed* by an
 * agent that then died. It sits in the ledger as `active` with a lease
 * that nobody will release, and because only the first order in the queue
 * can take the slot, it blocks every deploy behind it until the lease
 * runs out.
 *
 * So this tool does both:
 *
 *   restore  - an expired order goes back to `queued` (it keeps its id and
 *              token, so its owner can still claim it),
 *   release  - an active order whose agent is gone is closed as
 *              `cancelled`, and its run is closed with it.
 *
 * USAGE
 * -----
 *   node tools/deploy-ledger-restore.mjs restore --id WO-...
 *   node tools/deploy-ledger-restore.mjs release --id WO-... [--reason TEXT]
 */
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath } from './deploy-ledger.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
if (cmd !== 'restore' && cmd !== 'release') {
  console.error(
    'usage: node deploy-ledger-restore.mjs restore|release --id WO-... [--reason TEXT]'
  );
  process.exit(2);
}
const idIndex = args.indexOf('--id');
if (idIndex < 0 || !args[idIndex + 1]) {
  console.error('--id is required');
  process.exit(2);
}
const reasonIndex = args.indexOf('--reason');
const reason = reasonIndex >= 0 ? args[reasonIndex + 1] : null;
const workId = args[idIndex + 1];

const db = new DatabaseSync(defaultDbPath());
const now = Date.now();

const row = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(workId);
if (!row) {
  console.error(`no such work order: ${workId}`);
  process.exit(3);
}

if (cmd === 'release') {
  if (row.status !== 'active') {
    console.log(`${workId} is ${row.status}, not active - nothing to release`);
    process.exit(0);
  }
  const text = reason ?? 'the agent that owned this order is gone; the slot was released';
  db.prepare(
    `UPDATE work_orders
        SET status = 'cancelled', outcome = 'cancelled', finished_ms = ?, error = ?,
            lease_until_ms = NULL, phase = 'released'
      WHERE id = ?`
  ).run(now, text, workId);
  db.prepare(
    "UPDATE runs SET finished_ms = ?, outcome = 'cancelled' WHERE work_id = ? AND finished_ms IS NULL"
  ).run(now, workId);
  console.log(`released ${workId} (${row.agent}) - ${text}`);
  console.log('  the next order in the queue can now take the slot');
  process.exit(0);
}

/* restore */
if (row.status !== 'expired') {
  console.log(`${workId} is ${row.status}, not expired - nothing to do`);
  process.exit(0);
}

db.prepare(
  `UPDATE work_orders
      SET status = 'queued', phase = 'queued', finished_ms = NULL, error = NULL,
          heartbeat_ms = ?, enqueued_ms = ?
    WHERE id = ?`
).run(now, now, workId);

const runs = db
  .prepare('SELECT id FROM runs WHERE work_id = ? AND finished_ms IS NOT NULL')
  .all(workId);
for (const r of runs) {
  db.prepare('UPDATE runs SET finished_ms = NULL, outcome = NULL WHERE id = ?').run(r.id);
}

console.log(`restored ${workId} (${row.agent}) to the queue`);
console.log(`  reopened ${runs.length} run(s)`);
