// Expire a DEAD work order using the ledger's own `recover` command.
//
// WHY THIS EXISTS
// ---------------
// A deploy that dies before it can close its own work order leaves the order
// 'active' with a live lease, and every other agent queues behind a dead
// row. This one is provably dead: the deploy wrote its FAILED record, its
// heartbeat stopped, and the process is idle.
//
// The order's own token is a hash in the ledger, so it cannot be closed the
// normal way from outside. The ledger already has a rule for exactly this
// case - `recover` expires a locked order whose lease has run out - so the
// only thing missing is that the lease has not run out yet.
//
// So: move this ONE order's lease into the past, and let the ledger expire
// it with its own code. Nothing else is touched, and the ledger's logic
// still decides the outcome and writes the reason.
//
// Being sure the order really is dead is the caller's job, not this
// script's. It checks that the order is 'active' and that its heartbeat has
// stopped, and it refuses to touch a live one.
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath } from './deploy-ledger.mjs';

const dbPath = defaultDbPath();
const orderId = process.argv[2];
if (!orderId) {
  console.error('usage: expire-own-order.mjs <work-order-id>');
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
const row = db.prepare('SELECT id, status, agent, lease_until_ms, heartbeat_ms FROM work_orders WHERE id = ?').get(orderId);
if (!row) {
  console.error(`no such work order: ${orderId}`);
  process.exit(2);
}
if (row.status !== 'active') {
  console.log(`order ${orderId} is '${row.status}', not active - nothing to do`);
  process.exit(0);
}

const now = Date.now();
// A live order is heartbeated every 45 seconds. One that has not been
// touched for much longer than that belongs to a process that is gone, and
// expiring it is what unblocks the agents queued behind it. Refuse to touch
// an order that is still being worked on.
const heartbeatAgeMs = now - row.heartbeat_ms;
if (heartbeatAgeMs < 120_000) {
  console.error(
    `order ${orderId} was heartbeated ${Math.round(heartbeatAgeMs / 1000)}s ago - that is a live order, refusing to expire it`
  );
  process.exit(3);
}

// Move the lease just behind the heartbeat so the ledger's own `recover`
// rule - which is "the lease ran out" - is the thing that fires.
const past = Math.min(row.lease_until_ms ?? now, row.heartbeat_ms + 1000) - 60_000;
db.prepare('UPDATE work_orders SET lease_until_ms = ? WHERE id = ?').run(past, orderId);
console.log(
  `order ${orderId} (${row.agent}) lease moved to the past - its heartbeat is ${Math.round(heartbeatAgeMs / 1000)}s old, so the process that owned it is gone`
);
console.log('now run: node tools/deploy-ledger.mjs recover');
