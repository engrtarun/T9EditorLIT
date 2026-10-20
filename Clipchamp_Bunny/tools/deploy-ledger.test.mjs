import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LedgerError,
  claimWork,
  closeLedger,
  finishWork,
  getStatus,
  heartbeatWork,
  openLedger,
  requestWork
} from './deploy-ledger.mjs';

const BASE = Date.UTC(2026, 9, 20, 12, 0, 0);
const MINUTE = 60_000;

function request(db, overrides = {}, now = BASE) {
  return requestWork(
    db,
    {
      agent: 'agent-a',
      model: 'opencode/test-model',
      task: 'make the desktop build current',
      why: 'the installed app must carry the new code',
      etaMinutes: 10,
      scope: 'app',
      ...overrides
    },
    now
  );
}

test('request validates the form instead of accepting empty excuses', () => {
  const db = openLedger(':memory:');
  try {
    assert.throws(() => request(db, { task: 'fix' }), LedgerError);
    assert.throws(() => request(db, { why: 'stuff' }), LedgerError);
    assert.throws(() => request(db, { etaMinutes: 0 }), LedgerError);
    assert.throws(() => request(db, { etaMinutes: 999 }), LedgerError);
    assert.throws(() => request(db, { scope: 'everything' }), LedgerError);
    assert.throws(() => request(db, { priority: 90 }), /emergency/);
  } finally {
    closeLedger(db);
  }
});

test('one active deploy at a time, then strict FIFO', () => {
  const db = openLedger(':memory:');
  try {
    const first = request(db, { agent: 'agent-a', task: 'first queued job ok' }, BASE);
    const second = request(db, { agent: 'agent-b', task: 'second queued job ok' }, BASE + 1000);

    const claimFirst = claimWork(db, { workId: first.workId, token: first.token }, BASE + 2000);
    assert.equal(claimFirst.state, 'active');

    const waiting = claimWork(db, { workId: second.workId, token: second.token }, BASE + 2000);
    assert.equal(waiting.state, 'waiting');
    assert.equal(waiting.active.id, first.workId);
    assert.equal(waiting.position, 1);

    const done = finishWork(
      db,
      { workId: first.workId, token: first.token, outcome: 'shipped', mode: 'installed' },
      BASE + 3 * MINUTE
    );
    assert.equal(done.status, 'shipped');

    const claimSecond = claimWork(
      db,
      { workId: second.workId, token: second.token },
      BASE + 3 * MINUTE
    );
    assert.equal(claimSecond.state, 'active');
  } finally {
    closeLedger(db);
  }
});

test('priority is fair: emergency jumps, aging beats a newer normal job, FIFO breaks ties', () => {
  const db = openLedger(':memory:');
  try {
    const oldNormal = request(
      db,
      { agent: 'old-normal', task: 'old normal priority work', priority: 50, etaMinutes: 5 },
      BASE
    );
    const emergency = request(
      db,
      {
        agent: 'emergency',
        task: 'fresh emergency work',
        priority: 90,
        emergency: true,
        etaMinutes: 5
      },
      BASE + MINUTE
    );

    const waiting = claimWork(
      db,
      { workId: oldNormal.workId, token: oldNormal.token },
      BASE + 2 * MINUTE
    );
    assert.equal(waiting.state, 'waiting', 'an emergency job jumps an older normal job');
    assert.equal(waiting.position, 2);
    assert.equal(waiting.ahead[0].id, emergency.workId);

    const emergencyActive = claimWork(
      db,
      { workId: emergency.workId, token: emergency.token },
      BASE + 2 * MINUTE
    );
    assert.equal(emergencyActive.state, 'active');

    finishWork(
      db,
      { workId: emergency.workId, token: emergency.token, outcome: 'cancelled' },
      BASE + 3 * MINUTE
    );
    finishWork(
      db,
      { workId: oldNormal.workId, token: oldNormal.token, outcome: 'cancelled' },
      BASE + 3 * MINUTE
    );

    // A low-priority job that has waited an hour gets +50. A normal job
    // requested 59 minutes later is still at 51, so the old job wins - no
    // starvation from a stream of fresh work.
    const oldLow = request(
      db,
      { agent: 'old-low', task: 'old low priority work', priority: 10, etaMinutes: 5 },
      BASE + 4 * MINUTE
    );
    // A real deploy keeps calling claim/heartbeat while it waits, so a queued
    // order does not expire. Do the same here.
    for (const minute of [20, 40, 53]) {
      heartbeatWork(
        db,
        { workId: oldLow.workId, token: oldLow.token, phase: 'waiting' },
        BASE + minute * MINUTE
      );
    }

    const newerNormal = request(
      db,
      { agent: 'newer', task: 'newer normal priority work', priority: 50, etaMinutes: 5 },
      BASE + 54 * MINUTE
    );

    const aged = claimWork(db, { workId: oldLow.workId, token: oldLow.token }, BASE + 54 * MINUTE);
    assert.equal(aged.state, 'active', 'the aged low-priority job wins over the newer normal job');
    assert.ok(newerNormal.workId);

    finishWork(
      db,
      { workId: oldLow.workId, token: oldLow.token, outcome: 'cancelled' },
      BASE + 65 * MINUTE
    );

    // Same priority, same age: the older enqueue wins.
    const tieA = request(db, { agent: 'tie-a', task: 'tie break first job' }, BASE + 70 * MINUTE);
    const tieB = request(db, { agent: 'tie-b', task: 'tie break second job' }, BASE + 71 * MINUTE);
    const tie = claimWork(db, { workId: tieB.workId, token: tieB.token }, BASE + 72 * MINUTE);
    assert.equal(tie.state, 'waiting');
    assert.equal(tie.position, 2);
    const tieFirst = claimWork(db, { workId: tieA.workId, token: tieA.token }, BASE + 72 * MINUTE);
    assert.equal(tieFirst.state, 'active');
  } finally {
    closeLedger(db);
  }
});

test('an abandoned active lease expires and unblocks the queue', () => {
  const db = openLedger(':memory:');
  try {
    const abandoned = request(db, { agent: 'agent-a', task: 'this agent will vanish' }, BASE);
    const next = request(db, { agent: 'agent-b', task: 'this agent is still here' }, BASE + 1000);

    const active = claimWork(
      db,
      { workId: abandoned.workId, token: abandoned.token, leaseMinutes: 5 },
      BASE + 2000
    );
    assert.equal(active.state, 'active');

    const afterLease = claimWork(db, { workId: next.workId, token: next.token }, BASE + 6 * MINUTE);
    assert.equal(afterLease.state, 'active');

    const status = getStatus(db, { now: BASE + 6 * MINUTE });
    const expired = status.recent.find((row) => row.id === abandoned.workId);
    assert.equal(expired.status, 'expired');
    assert.match(expired.error, /lease expired/);
  } finally {
    closeLedger(db);
  }
});

test('heartbeat keeps a long build alive and a token cannot finish someone else work', async () => {
  const db = openLedger(':memory:');
  try {
    const work = request(db, { etaMinutes: 20 }, BASE);
    const active = claimWork(
      db,
      { workId: work.workId, token: work.token, leaseMinutes: 5 },
      BASE + 1000
    );
    assert.equal(active.state, 'active');

    heartbeatWork(
      db,
      { workId: work.workId, token: work.token, phase: 'build', leaseMinutes: 5 },
      BASE + 4 * MINUTE
    );

    const other = request(
      db,
      { agent: 'agent-b', task: 'a different queued job' },
      BASE + 2 * MINUTE
    );
    const stillWaiting = claimWork(
      db,
      { workId: other.workId, token: other.token },
      BASE + 6 * MINUTE
    );
    assert.equal(stillWaiting.state, 'waiting');

    assert.throws(
      () =>
        finishWork(
          db,
          { workId: work.workId, token: other.token, outcome: 'shipped' },
          BASE + 7 * MINUTE
        ),
      /token/
    );

    const done = finishWork(
      db,
      { workId: work.workId, token: work.token, outcome: 'shipped', mode: 'staged' },
      BASE + 7 * MINUTE
    );
    assert.equal(done.status, 'shipped');
    assert.equal(done.mode, 'staged');
  } finally {
    closeLedger(db);
  }
});

test('status reports the active job, queue and recent history', () => {
  const db = openLedger(':memory:');
  try {
    const work = request(db, { agent: 'agent-a' }, BASE);
    claimWork(db, { workId: work.workId, token: work.token }, BASE + 1000);
    const status = getStatus(db, { now: BASE + 2 * MINUTE });
    assert.equal(status.active.id, work.workId);
    assert.equal(status.queueDepth, 0);
    assert.equal(status.recent[0].id, work.workId);
    assert.equal(status.recent[0].status, 'active');
    assert.equal(status.counts.active, 1);
  } finally {
    closeLedger(db);
  }
});
