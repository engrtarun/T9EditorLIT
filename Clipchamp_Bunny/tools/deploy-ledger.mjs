#!/usr/bin/env node
/**
 * T9 Editor LIT - deployment ledger.
 *
 * One SQLite file is the single source of truth for every desktop deploy:
 *
 *   - who asked (agent + model + session)
 *   - what and why (task + reason)
 *   - how long they thought it would take (ETA)
 *   - when they arrived, started and finished
 *   - whether the installed app, the staged update and the localhost daemon
 *     actually carry the build they claim
 *
 * The queue is fair: normal work is FIFO, one deploy is active at a time, and
 * priority ages by one point per minute (capped at +50) so nobody can starve.
 *
 * Node's built-in `node:sqlite` is used on purpose - no native module, no
 * service, no extra process holding the database. Every CLI call opens the
 * file, does one transaction, and exits.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const DEFAULT_LEASE_MINUTES = 30;
const QUEUE_TTL_MS = 15 * 60 * 1000;
const AGING_POINTS_PER_MINUTE = 1;
const AGING_CAP = 50;
const VALID_SCOPES = new Set(['app', 'go', 'both', 'docs']);
const VALID_OUTCOMES = new Set(['shipped', 'failed', 'cancelled', 'expired']);

/* ------------------------------------------------------------------ errors */

export class LedgerError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = 'LedgerError';
    this.exitCode = exitCode;
  }
}

/* ------------------------------------------------------------------- paths */

export function defaultDbPath() {
  if (process.env.T9_LEDGER_DB) return resolve(process.env.T9_LEDGER_DB);
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(local, 'T9EditorLIT', 'deploy', 'ledger.db');
}

export function defaultDeployDir() {
  return dirname(defaultDbPath());
}

/* -------------------------------------------------------------------- misc */

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function randomHex(bytes = 4) {
  return randomBytes(bytes).toString('hex');
}

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function minutes(ms) {
  return Math.round((ms / 60000) * 10) / 10;
}

function truncate(value, max) {
  if (value == null) return null;
  const text = String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function exactText(value, name, min, max) {
  if (typeof value !== 'string') throw new LedgerError(`${name} is required`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length < min) {
    throw new LedgerError(`${name} must be at least ${min} characters (got ${text.length})`);
  }
  if (text.length > max) throw new LedgerError(`${name} must be at most ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new LedgerError(`${name} must not contain control characters or newlines`);
  }
  return text;
}

function optionalText(value, name, max) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new LedgerError(`${name} must be text`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length > max) throw new LedgerError(`${name} must be at most ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new LedgerError(`${name} must not contain control characters or newlines`);
  }
  return text;
}

function integer(value, name, min, max, fallback) {
  if (value == null || value === '' || value === true) {
    if (fallback !== undefined) return fallback;
    throw new LedgerError(`${name} is required`);
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw new LedgerError(`${name} must be a whole number`);
  if (n < min || n > max) throw new LedgerError(`${name} must be between ${min} and ${max}`);
  return n;
}

function bool(value) {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return Boolean(value);
}

function newWorkId(now) {
  return `WO-${utcStamp(now)}-${randomHex(3)}`;
}

function newRunId(now) {
  return `RUN-${utcStamp(now)}-${randomHex(3)}`;
}

function newSessionId(now) {
  return `S-${utcStamp(now)}-${randomHex(3)}`;
}

/* ------------------------------------------------------------------- schema */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_orders (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                    ('queued','active','shipped','failed','cancelled','expired')),
  priority        INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 100),
  emergency       INTEGER NOT NULL DEFAULT 0,
  created_ms      INTEGER NOT NULL,
  enqueued_ms     INTEGER NOT NULL,
  started_ms      INTEGER,
  finished_ms     INTEGER,
  heartbeat_ms    INTEGER NOT NULL,
  lease_until_ms  INTEGER,
  phase           TEXT NOT NULL DEFAULT 'requested',
  agent           TEXT NOT NULL,
  model           TEXT NOT NULL,
  session_id      TEXT,
  task            TEXT NOT NULL,
  why             TEXT NOT NULL,
  eta_minutes     INTEGER NOT NULL CHECK (eta_minutes BETWEEN 1 AND 480),
  scope           TEXT NOT NULL CHECK (scope IN ('app','go','both','docs')),
  worktree        TEXT,
  branch          TEXT,
  commit_hash     TEXT,
  git_dirty       INTEGER,
  host            TEXT,
  agent_pid       INTEGER,
  outcome         TEXT,
  mode            TEXT,
  build_id        TEXT,
  error           TEXT,
  evidence_path   TEXT,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  work_id         TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  attempt         INTEGER NOT NULL,
  started_ms      INTEGER NOT NULL,
  finished_ms     INTEGER,
  outcome         TEXT,
  mode            TEXT,
  build_id        TEXT,
  app_sha256      TEXT,
  installed_sha256 TEXT,
  staged_sha256   TEXT,
  daemon_sha256   TEXT,
  daemon_version  TEXT,
  marker_json     TEXT,
  evidence_json   TEXT,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id   TEXT,
  run_id    TEXT,
  at_ms     INTEGER NOT NULL,
  level     TEXT NOT NULL,
  phase     TEXT NOT NULL,
  message   TEXT NOT NULL,
  data_json TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  model         TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL,
  ended_ms      INTEGER,
  deploy_count  INTEGER NOT NULL DEFAULT 0,
  worktree      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_one_active
  ON work_orders(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_queue
  ON work_orders(status, priority DESC, enqueued_ms ASC, id ASC);
CREATE INDEX IF NOT EXISTS ix_runs_work
  ON runs(work_id, started_ms);
CREATE INDEX IF NOT EXISTS ix_events_work
  ON events(work_id, at_ms);
CREATE INDEX IF NOT EXISTS ix_sessions_seen
  ON sessions(last_seen_ms DESC);
`;

export function openLedger(dbPath = defaultDbPath()) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000;');
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION)
  );
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    'last_opened_ms',
    String(Date.now())
  );
  return db;
}

export function closeLedger(db, dbPath) {
  try {
    if (dbPath && dbPath !== ':memory:') db.exec('PRAGMA wal_checkpoint(PASSIVE);');
  } catch {
    /* checkpoint is best-effort */
  }
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      /* the transaction may already be gone */
    }
    throw error;
  }
}

/* -------------------------------------------------------------- queue maths */

function effectivePriority(row, now) {
  const waitedMinutes = Math.max(0, (now - row.enqueued_ms) / 60000);
  const bonus = Math.min(AGING_CAP, waitedMinutes * AGING_POINTS_PER_MINUTE);
  return Math.round((row.priority + bonus) * 1000) / 1000;
}

function queueRows(db, now) {
  const rows = db.prepare("SELECT * FROM work_orders WHERE status = 'queued'").all();
  return rows
    .map((row) => ({ ...row, effective_priority: effectivePriority(row, now) }))
    .sort((a, b) => {
      if (b.effective_priority !== a.effective_priority) {
        return b.effective_priority - a.effective_priority;
      }
      if (a.enqueued_ms !== b.enqueued_ms) return a.enqueued_ms - b.enqueued_ms;
      return a.id.localeCompare(b.id);
    });
}

function activeRow(db) {
  return db.prepare("SELECT * FROM work_orders WHERE status = 'active' LIMIT 1").get() ?? null;
}

function rowById(db, id) {
  return db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id) ?? null;
}

function summary(row, now, position = null) {
  if (!row) return null;
  const waited = Math.max(0, (now - row.enqueued_ms) / 60000);
  const remaining =
    row.status === 'active' && row.started_ms
      ? Math.max(0, row.eta_minutes - (now - row.started_ms) / 60000)
      : row.eta_minutes;
  return {
    id: row.id,
    status: row.status,
    agent: row.agent,
    model: row.model,
    sessionId: row.session_id,
    task: row.task,
    why: row.why,
    scope: row.scope,
    priority: row.priority,
    effectivePriority: effectivePriority(row, now),
    emergency: Boolean(row.emergency),
    etaMinutes: row.eta_minutes,
    waitedMinutes: Math.round(waited * 10) / 10,
    remainingMinutes: Math.round(remaining * 10) / 10,
    position,
    createdAt: iso(row.created_ms),
    enqueuedAt: iso(row.enqueued_ms),
    startedAt: iso(row.started_ms),
    finishedAt: iso(row.finished_ms),
    heartbeatAt: iso(row.heartbeat_ms),
    heartbeatAgeSeconds: Math.max(0, Math.round((now - row.heartbeat_ms) / 1000)),
    leaseUntil: iso(row.lease_until_ms),
    leaseSecondsLeft:
      row.lease_until_ms == null
        ? null
        : Math.max(0, Math.round((row.lease_until_ms - now) / 1000)),
    phase: row.phase,
    mode: row.mode,
    buildId: row.build_id,
    outcome: row.outcome,
    error: row.error,
    worktree: row.worktree,
    branch: row.branch,
    commit: row.commit_hash,
    gitDirty: row.git_dirty == null ? null : Boolean(row.git_dirty),
    host: row.host,
    evidencePath: row.evidence_path
  };
}

function insertEvent(
  db,
  { workId = null, runId = null, level = 'info', phase, message, data },
  now
) {
  db.prepare(
    `INSERT INTO events(work_id, run_id, at_ms, level, phase, message, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    workId ?? null,
    runId ?? null,
    now,
    level,
    phase ?? 'note',
    truncate(message, 2000),
    data == null ? null : JSON.stringify(data)
  );
}

function closeOpenRun(db, workId, outcome, now, error = null) {
  const run = db
    .prepare(
      'SELECT * FROM runs WHERE work_id = ? AND finished_ms IS NULL ORDER BY started_ms DESC LIMIT 1'
    )
    .get(workId);
  if (!run) return;
  db.prepare(
    `UPDATE runs SET finished_ms = ?, outcome = ?, error = COALESCE(?, error) WHERE id = ?`
  ).run(now, outcome, truncate(error, 4000), run.id);
}

function touchSession(db, { sessionId, agent, model, worktree }, now, increment = false) {
  if (!sessionId) return null;
  const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (existing) {
    db.prepare(
      `UPDATE sessions SET last_seen_ms = ?,
         ended_ms = CASE WHEN ? = 1 THEN NULL ELSE ended_ms END,
         deploy_count = deploy_count + ? WHERE id = ?`
    ).run(now, increment ? 1 : 0, increment ? 1 : 0, sessionId);
  } else {
    db.prepare(
      `INSERT INTO sessions(id, agent, model, first_seen_ms, last_seen_ms, deploy_count, worktree)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sessionId, agent, model, now, now, increment ? 1 : 0, worktree ?? null);
  }
  return sessionId;
}

/* ------------------------------------------------------------------ reaping */

function reapLocked(db, now, maxHeartbeatAgeMs = null, keepAliveId = null) {
  const expired = [];
  const active = maxHeartbeatAgeMs
    ? db
        .prepare(
          `SELECT * FROM work_orders WHERE status = 'active' AND (
             (lease_until_ms IS NOT NULL AND lease_until_ms < ?)
             OR (COALESCE(heartbeat_ms, started_ms, enqueued_ms) < ?)
           )`
        )
        .all(now, now - maxHeartbeatAgeMs)
    : db
        .prepare(
          "SELECT * FROM work_orders WHERE status = 'active' AND lease_until_ms IS NOT NULL AND lease_until_ms < ?"
        )
        .all(now);

  const seen = new Set();
  for (const row of active) {
    if (keepAliveId && row.id === keepAliveId) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    const lastSeen = row.heartbeat_ms ?? row.started_ms ?? row.enqueued_ms ?? now;
    const staleHeartbeat = maxHeartbeatAgeMs != null && lastSeen < now - maxHeartbeatAgeMs;
    const reason = staleHeartbeat ? 'heartbeat_stale' : 'lease_expired';
    const errorText = staleHeartbeat
      ? 'heartbeat stale - the agent stopped'
      : 'lease expired - the agent stopped sending heartbeats';

    db.prepare(
      `UPDATE work_orders SET status = 'expired', outcome = 'expired', finished_ms = ?,
         error = COALESCE(error, ?) WHERE id = ?`
    ).run(now, errorText, row.id);
    closeOpenRun(db, row.id, 'expired', now, reason);
    insertEvent(
      db,
      {
        workId: row.id,
        level: 'warn',
        phase: 'reaper',
        message: staleHeartbeat
          ? `heartbeat stale after ${minutes(now - lastSeen)}m - the agent stopped`
          : `lease expired after ${minutes(now - lastSeen)}m without a heartbeat`
      },
      now
    );
    expired.push({ id: row.id, reason, status: 'expired' });
  }

  const stale = db
    .prepare("SELECT * FROM work_orders WHERE status = 'queued' AND heartbeat_ms < ?")
    .all(now - QUEUE_TTL_MS);
  for (const row of stale) {
    // `keepAliveId` is the order that asked for this reap (see claimWork).
    // A claim refreshes the heartbeat on success, so *its own* order must
    // never be reaped here: the reaper used to expire the caller's order
    // first, `rowById` then read `expired`, and the claim threw - which
    // rolled the transaction back and left a queued row that no claim could
    // ever take again. That is the doom loop that killed every deploy.
    if (keepAliveId && row.id === keepAliveId) continue;
    db.prepare(
      `UPDATE work_orders SET status = 'expired', outcome = 'expired', finished_ms = ?,
         error = COALESCE(error, 'queued too long without a claim - the agent vanished') WHERE id = ?`
    ).run(now, row.id);
    insertEvent(
      db,
      {
        workId: row.id,
        level: 'warn',
        phase: 'reaper',
        message: `queued work expired after ${minutes(now - row.enqueued_ms)}m without a claim`
      },
      now
    );
    expired.push({ id: row.id, reason: 'queue_timeout', status: 'expired' });
  }
  return expired;
}

export function reap(db, now = Date.now(), maxHeartbeatAgeMs = null) {
  return transaction(db, () => reapLocked(db, now, maxHeartbeatAgeMs));
}

/* ---------------------------------------------------------------- requests */

export function requestWork(db, input, now = Date.now()) {
  const agent = exactText(input.agent, 'agent', 2, 64);
  const model = exactText(input.model, 'model', 3, 120);
  const task = exactText(input.task, 'task', 8, 200);
  const why = exactText(input.why, 'why', 12, 2000);
  const scope = String(input.scope ?? 'app').toLowerCase();
  if (!VALID_SCOPES.has(scope)) {
    throw new LedgerError(`scope must be one of ${[...VALID_SCOPES].join(', ')}`);
  }
  const etaMinutes = integer(input.etaMinutes, 'etaMinutes', 1, 480);
  const emergency = bool(input.emergency);
  let priority = integer(input.priority, 'priority', 0, 100, 50);
  if (emergency) {
    priority = Math.max(priority, 90);
  } else if (priority > 60) {
    throw new LedgerError('priority above 60 needs --emergency (and a real outage reason)');
  }
  const sessionId = optionalText(input.sessionId, 'sessionId', 120) ?? newSessionId(now);
  const worktree = optionalText(input.worktree, 'worktree', 500);
  const branch = optionalText(input.branch, 'branch', 200);
  const commit = optionalText(input.commit, 'commit', 100);
  const host = optionalText(input.host, 'host', 120) ?? hostname();
  const agentPid =
    input.agentPid == null ? null : integer(input.agentPid, 'agentPid', 1, 2 ** 31 - 1, null);
  const notes = optionalText(input.notes, 'notes', 2000);

  return transaction(db, () => {
    const expired = reapLocked(db, now);
    const id = newWorkId(now);
    const token = randomBytes(18).toString('hex');
    db.prepare(
      `INSERT INTO work_orders(
         id, token_hash, status, priority, emergency, created_ms, enqueued_ms,
         heartbeat_ms, phase, agent, model, session_id, task, why, eta_minutes,
         scope, worktree, branch, commit_hash, git_dirty, host, agent_pid, notes)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      sha256(token),
      priority,
      emergency ? 1 : 0,
      now,
      now,
      now,
      agent,
      model,
      sessionId,
      task,
      why,
      etaMinutes,
      scope,
      worktree,
      branch,
      commit,
      input.gitDirty == null ? null : bool(input.gitDirty) ? 1 : 0,
      host,
      agentPid,
      notes
    );
    touchSession(db, { sessionId, agent, model, worktree }, now, true);
    insertEvent(
      db,
      {
        workId: id,
        phase: 'requested',
        message: `${agent} (${model}) requested ${scope} deploy: ${task}`,
        data: { etaMinutes, priority, emergency, sessionId }
      },
      now
    );

    const queue = queueRows(db, now);
    const ahead = queue.filter((row) => row.id !== id);
    const active = activeRow(db);
    const position = queue.findIndex((row) => row.id === id) + 1;
    const activeRemaining =
      active && active.started_ms
        ? Math.max(0, active.eta_minutes - (now - active.started_ms) / 60000)
        : 0;
    const etaAheadMinutes =
      Math.round((ahead.reduce((sum, row) => sum + row.eta_minutes, 0) + activeRemaining) * 10) /
      10;

    return {
      ok: true,
      workId: id,
      token,
      sessionId,
      status: 'queued',
      position: position || null,
      queueDepth: queue.length,
      ahead: ahead.slice(0, 5).map((row, index) => summary(row, now, index + 1)),
      active: summary(active, now, active ? 1 : null),
      etaAheadMinutes,
      createdAt: iso(now),
      expired
    };
  });
}

/* ------------------------------------------------------------------- claim */

export function claimWork(db, input, now = Date.now()) {
  const workId = exactText(input.workId, 'workId', 4, 80);
  const token = exactText(input.token, 'token', 8, 200);
  const leaseMinutes = integer(input.leaseMinutes, 'leaseMinutes', 5, 240, DEFAULT_LEASE_MINUTES);

  return transaction(db, () => {
    const expired = reapLocked(db, now, null, workId);
    const row = rowById(db, workId);
    if (!row) throw new LedgerError(`unknown work order ${workId}`, 3);
    if (row.token_hash !== sha256(token))
      throw new LedgerError('work-order token does not match', 3);

    if (row.status === 'expired') {
      // The queue expired this order while its agent was still waiting
      // (a slow/queued claim, a stalled machine, a long build lock). The
      // agent is alive and holding the token, so resurrect the order
      // instead of failing the deploy: the token proves ownership, and
      // leaving it `expired` meant every later claim threw forever.
      db.prepare(
        `UPDATE work_orders SET status = 'queued', outcome = NULL, finished_ms = NULL,
           error = NULL, heartbeat_ms = ?, enqueued_ms = ?, lease_until_ms = NULL WHERE id = ?`
      ).run(now, now, workId);
      insertEvent(
        db,
        {
          workId,
          level: 'warn',
          phase: 'claim',
          message: `requeued by its owner after the queue expired it (agent still alive)`
        },
        now
      );
      // `row` was read before the update; refresh the fields the code below
      // branches on, otherwise the caller still sees `expired` and throws.
      row.status = 'queued';
      row.outcome = null;
      row.finished_ms = null;
      row.error = null;
      row.heartbeat_ms = now;
      row.enqueued_ms = now;
      row.lease_until_ms = null;
    }

    if (row.status === 'active') {
      db.prepare(`UPDATE work_orders SET heartbeat_ms = ?, lease_until_ms = ? WHERE id = ?`).run(
        now,
        now + leaseMinutes * 60000,
        workId
      );
      const run = db
        .prepare(
          'SELECT * FROM runs WHERE work_id = ? AND finished_ms IS NULL ORDER BY started_ms DESC LIMIT 1'
        )
        .get(workId);
      return {
        ok: true,
        state: 'active',
        workId,
        runId: run?.id ?? null,
        startedAt: iso(row.started_ms ?? now),
        leaseUntil: iso(now + leaseMinutes * 60000),
        expired
      };
    }

    if (row.status !== 'queued') {
      throw new LedgerError(`work order ${workId} is ${row.status}, not queued`, 3);
    }

    db.prepare('UPDATE work_orders SET heartbeat_ms = ? WHERE id = ?').run(now, workId);
    const active = activeRow(db);
    const queue = queueRows(db, now);
    const position = queue.findIndex((item) => item.id === workId) + 1;

    if (active && active.id !== workId) {
      return {
        ok: true,
        state: 'waiting',
        workId,
        position: position || null,
        queueDepth: queue.length,
        active: summary(active, now, 1),
        ahead: queue
          .filter(
            (item) => item.id !== workId && queue.findIndex((x) => x.id === item.id) < position - 1
          )
          .slice(0, 5)
          .map((item, index) => summary(item, now, index + 1)),
        etaAheadMinutes:
          Math.round(
            (Math.max(0, active.eta_minutes - (now - (active.started_ms ?? now)) / 60000) +
              queue
                .filter(
                  (item) =>
                    item.id !== workId && queue.findIndex((x) => x.id === item.id) < position - 1
                )
                .reduce((sum, item) => sum + item.eta_minutes, 0)) *
              10
          ) / 10,
        expired
      };
    }

    if (position !== 1) {
      return {
        ok: true,
        state: 'waiting',
        workId,
        position,
        queueDepth: queue.length,
        active: null,
        ahead: queue
          .slice(0, Math.max(0, position - 1))
          .slice(0, 5)
          .map((item, index) => summary(item, now, index + 1)),
        etaAheadMinutes:
          Math.round(
            queue
              .slice(0, Math.max(0, position - 1))
              .reduce((sum, item) => sum + item.eta_minutes, 0) * 10
          ) / 10,
        expired
      };
    }

    db.prepare(
      `UPDATE work_orders SET status = 'active', started_ms = COALESCE(started_ms, ?),
         heartbeat_ms = ?, lease_until_ms = ?, phase = 'starting' WHERE id = ?`
    ).run(now, now, now + leaseMinutes * 60000, workId);

    const attempt =
      (db.prepare('SELECT COUNT(*) AS c FROM runs WHERE work_id = ?').get(workId)?.c ?? 0) + 1;
    const runId = newRunId(now);
    db.prepare('INSERT INTO runs(id, work_id, attempt, started_ms) VALUES (?, ?, ?, ?)').run(
      runId,
      workId,
      attempt,
      now
    );
    insertEvent(
      db,
      {
        workId,
        runId,
        phase: 'claimed',
        message: `claimed by ${row.agent} (${row.model}); lease ${leaseMinutes}m`
      },
      now
    );

    return {
      ok: true,
      state: 'active',
      workId,
      runId,
      attempt,
      startedAt: iso(now),
      leaseUntil: iso(now + leaseMinutes * 60000),
      expired
    };
  });
}

/* --------------------------------------------------------------- heartbeat */

export function heartbeatWork(db, input, now = Date.now()) {
  const workId = exactText(input.workId, 'workId', 4, 80);
  const token = exactText(input.token, 'token', 8, 200);
  const phase = optionalText(input.phase, 'phase', 64) ?? 'working';
  const leaseMinutes = integer(input.leaseMinutes, 'leaseMinutes', 5, 240, DEFAULT_LEASE_MINUTES);

  return transaction(db, () => {
    const row = rowById(db, workId);
    if (!row) throw new LedgerError(`unknown work order ${workId}`, 3);
    if (row.token_hash !== sha256(token))
      throw new LedgerError('work-order token does not match', 3);
    if (!['queued', 'active'].includes(row.status)) {
      return { ok: true, state: row.status, workId };
    }

    const phaseChanged = row.phase !== phase;
    if (row.status === 'active') {
      db.prepare(
        `UPDATE work_orders SET heartbeat_ms = ?, lease_until_ms = ?, phase = ? WHERE id = ?`
      ).run(now, now + leaseMinutes * 60000, phase, workId);
    } else {
      db.prepare('UPDATE work_orders SET heartbeat_ms = ?, phase = ? WHERE id = ?').run(
        now,
        phase,
        workId
      );
    }
    if (phaseChanged) {
      insertEvent(db, { workId, phase, message: `phase: ${phase}` }, now);
    }
    return {
      ok: true,
      state: row.status,
      workId,
      phase,
      leaseUntil: row.status === 'active' ? iso(now + leaseMinutes * 60000) : null
    };
  });
}

/* ------------------------------------------------------------------ finish */

export function finishWork(db, input, now = Date.now()) {
  const workId = exactText(input.workId, 'workId', 4, 80);
  const token = exactText(input.token, 'token', 8, 200);
  const outcome = String(input.outcome ?? '').toLowerCase();
  if (!VALID_OUTCOMES.has(outcome)) {
    throw new LedgerError(`outcome must be one of ${[...VALID_OUTCOMES].join(', ')}`);
  }
  const mode = optionalText(input.mode, 'mode', 32);
  const buildId = optionalText(input.buildId, 'buildId', 200);
  const errorText = optionalText(input.error, 'error', 4000);
  const evidencePath = optionalText(input.evidence, 'evidence', 1000);
  let evidence = null;
  if (evidencePath && existsSync(evidencePath)) {
    try {
      evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    } catch {
      evidence = null;
    }
  }

  return transaction(db, () => {
    const row = rowById(db, workId);
    if (!row) throw new LedgerError(`unknown work order ${workId}`, 3);
    if (row.token_hash !== sha256(token))
      throw new LedgerError('work-order token does not match', 3);

    if (row.status === outcome) {
      return {
        ok: true,
        workId,
        status: outcome,
        alreadyFinished: true,
        startedAt: iso(row.started_ms),
        finishedAt: iso(row.finished_ms)
      };
    }

    const allowed =
      row.status === 'active' ||
      (row.status === 'queued' && ['cancelled', 'failed'].includes(outcome)) ||
      // An expired order is already terminal, but "the agent vanished" is a
      // guess made by the reaper, not the truth. The owner knows the truth
      // and finishes right after, so let the real outcome replace the guess
      // instead of throwing a second error at an agent that just succeeded.
      row.status === 'expired';
    if (!allowed) {
      throw new LedgerError(
        `work order ${workId} is ${row.status}; cannot finish as ${outcome}`,
        3
      );
    }

    db.prepare(
      `UPDATE work_orders SET status = ?, outcome = ?, finished_ms = ?, heartbeat_ms = ?,
         phase = 'finished', mode = COALESCE(?, mode), build_id = COALESCE(?, build_id),
         error = COALESCE(?, error), evidence_path = COALESCE(?, evidence_path) WHERE id = ?`
    ).run(
      outcome,
      outcome,
      now,
      now,
      mode ?? null,
      buildId ?? null,
      truncate(errorText, 4000) ?? null,
      evidencePath ?? null,
      workId
    );

    const run = db
      .prepare(
        'SELECT * FROM runs WHERE work_id = ? AND finished_ms IS NULL ORDER BY started_ms DESC LIMIT 1'
      )
      .get(workId);
    if (run) {
      const app = evidence?.app ?? {};
      const install = evidence?.install ?? {};
      const daemon = evidence?.daemon ?? {};
      const marker = evidence?.marker ?? null;
      db.prepare(
        `UPDATE runs SET finished_ms = ?, outcome = ?, mode = ?, build_id = ?,
           app_sha256 = ?, installed_sha256 = ?, staged_sha256 = ?, daemon_sha256 = ?,
           daemon_version = ?, marker_json = ?, evidence_json = ?, error = ? WHERE id = ?`
      ).run(
        now,
        outcome,
        mode ?? null,
        buildId ?? null,
        app.sha256 ?? null,
        install.liveSha256 ?? null,
        install.stagedSha256 ?? null,
        daemon.sha256 ?? null,
        daemon.version ?? null,
        marker == null ? null : JSON.stringify(marker),
        evidence == null ? null : JSON.stringify(evidence),
        truncate(errorText, 4000) ?? null,
        run.id
      );
    }

    insertEvent(
      db,
      {
        workId,
        runId: run?.id ?? null,
        level: outcome === 'shipped' ? 'info' : outcome === 'cancelled' ? 'warn' : 'error',
        phase: 'finished',
        message:
          outcome === 'shipped'
            ? `shipped (${mode ?? 'unknown'} mode)`
            : `${outcome}: ${errorText ?? ''}`,
        data: { buildId, mode, evidencePath }
      },
      now
    );
    if (row.session_id) {
      touchSession(
        db,
        { sessionId: row.session_id, agent: row.agent, model: row.model, worktree: row.worktree },
        now,
        false
      );
    }

    const started = row.started_ms ?? row.enqueued_ms;
    return {
      ok: true,
      workId,
      status: outcome,
      mode,
      buildId,
      startedAt: iso(row.started_ms),
      finishedAt: iso(now),
      durationMinutes: Math.round(((now - started) / 60000) * 10) / 10,
      etaMinutes: row.eta_minutes,
      etaDeltaMinutes: Math.round(((now - started) / 60000 - row.eta_minutes) * 10) / 10,
      evidencePath
    };
  });
}

/* ---------------------------------------------------------------- sessions */

export function sessionEnd(db, input, now = Date.now()) {
  const sessionId = exactText(input.sessionId, 'sessionId', 2, 120);
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!row) throw new LedgerError(`unknown session ${sessionId}`, 3);
    db.prepare('UPDATE sessions SET last_seen_ms = ?, ended_ms = ? WHERE id = ?').run(
      now,
      now,
      sessionId
    );
    return { ok: true, sessionId, firstSeen: iso(row.first_seen_ms), lastSeen: iso(now) };
  });
}

/* ------------------------------------------------------------------ status */

export function getStatus(db, { now = Date.now(), limit = 12 } = {}) {
  return transaction(db, () => {
    const expired = reapLocked(db, now);
    const active = activeRow(db);
    const queue = queueRows(db, now);
    const recent = db
      .prepare('SELECT * FROM work_orders ORDER BY created_ms DESC LIMIT ?')
      .all(limit);
    const sessions = db
      .prepare('SELECT * FROM sessions ORDER BY last_seen_ms DESC LIMIT ?')
      .all(limit);
    const counts = {};
    for (const row of db
      .prepare('SELECT status, COUNT(*) AS c FROM work_orders GROUP BY status')
      .all()) {
      counts[row.status] = row.c;
    }
    const shipped = db
      .prepare(
        "SELECT * FROM work_orders WHERE status = 'shipped' AND started_ms IS NOT NULL ORDER BY finished_ms DESC LIMIT 20"
      )
      .all();
    const deltas = shipped.map(
      (row) => (row.finished_ms - row.started_ms) / 60000 - row.eta_minutes
    );
    const avgEtaDelta =
      deltas.length === 0
        ? null
        : Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10;

    return {
      ok: true,
      now: iso(now),
      active: summary(active, now, active ? 1 : null),
      queue: queue.map((row, index) => summary(row, now, index + 1)),
      queueDepth: queue.length,
      recent: recent.map((row) => summary(row, now)),
      sessions: sessions.map((row) => ({
        id: row.id,
        agent: row.agent,
        model: row.model,
        firstSeen: iso(row.first_seen_ms),
        lastSeen: iso(row.last_seen_ms),
        endedAt: iso(row.ended_ms),
        deployCount: row.deploy_count,
        worktree: row.worktree,
        alive: row.ended_ms == null
      })),
      counts,
      avgEtaDeltaMinutes: avgEtaDelta,
      expired
    };
  });
}

/* ------------------------------------------------------------------- event */

export function addEvent(db, input, now = Date.now()) {
  const workId = optionalText(input.workId, 'workId', 80);
  const runId = optionalText(input.runId, 'runId', 80);
  const level = optionalText(input.level, 'level', 16) ?? 'info';
  const phase = optionalText(input.phase, 'phase', 64) ?? 'note';
  const message = exactText(input.message, 'message', 1, 2000);
  return transaction(db, () => {
    insertEvent(db, { workId, runId, level, phase, message, data: input.data }, now);
    return { ok: true, workId, phase, level };
  });
}

/* ----------------------------------------------------------- heartbeat loop */

export async function heartbeatLoop(options) {
  const dbPath = options.dbPath ?? defaultDbPath();
  const db = openLedger(dbPath);
  const intervalMs = Math.max(5, Number(options.intervalSeconds ?? 20)) * 1000;
  const maxMs = Math.max(1, Number(options.maxHours ?? 8)) * 3600000;
  const started = Date.now();
  let stopped = false;

  const stop = (code = 0) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    closeLedger(db, dbPath);
    process.exit(code);
  };

  const tick = () => {
    try {
      if (options.parentPid && !isProcessAlive(Number(options.parentPid))) {
        stop(0);
        return;
      }
      if (Date.now() - started > maxMs) {
        stop(0);
        return;
      }
      heartbeatWork(
        db,
        {
          workId: options.workId,
          token: options.token,
          phase: options.phase,
          leaseMinutes: options.leaseMinutes
        },
        Date.now()
      );
    } catch (error) {
      console.error(`deploy-ledger heartbeat: ${error.message}`);
      stop(1);
    }
  };

  const timer = setInterval(tick, intervalMs);
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));
  tick();
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- CLI utils */

function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }
    flags[key] = value;
  }
  return { positional, flags };
}

function flagText(flags, key, name) {
  const value = flags[key];
  if (value === undefined || value === true) return undefined;
  if (typeof value !== 'string') throw new LedgerError(`${name} must be text`);
  return value;
}

function flagInt(flags, key, fallback) {
  const value = flags[key];
  if (value === undefined) return fallback;
  if (value === true) throw new LedgerError(`--${key} needs a value`);
  return Number(value);
}

function requireFlag(flags, key, name) {
  const value = flagText(flags, key, name);
  if (value === undefined || value === '') throw new LedgerError(`${name} is required (--${key})`);
  return value;
}

function assertKnown(flags, allowed, command) {
  const known = new Set(['db', 'json', 'help', ...allowed]);
  for (const key of Object.keys(flags)) {
    if (!known.has(key)) throw new LedgerError(`unknown option --${key} for ${command}`);
  }
}

function requestFromFlags(flags) {
  return {
    agent: requireFlag(flags, 'agent', 'agent'),
    model: requireFlag(flags, 'model', 'model'),
    task: requireFlag(flags, 'task', 'task'),
    why: requireFlag(flags, 'why', 'why'),
    etaMinutes: flagInt(flags, 'eta', undefined),
    scope: flagText(flags, 'scope', 'scope') ?? 'app',
    priority: flagInt(flags, 'priority', 50),
    emergency: Boolean(flags.emergency),
    sessionId: flagText(flags, 'session', 'session'),
    worktree: flagText(flags, 'worktree', 'worktree'),
    branch: flagText(flags, 'branch', 'branch'),
    commit: flagText(flags, 'commit', 'commit'),
    // `--git-dirty` means true; `--git-clean` records false. Omitting both is
    // "unknown" (NULL) for callers that genuinely cannot inspect the tree.
    // This lets a normal clean deploy say false instead of leaving the ledger
    // ambiguous about whether anybody checked.
    gitDirty:
      flags['git-dirty'] !== undefined
        ? true
        : flags['git-clean'] !== undefined
          ? false
          : undefined,
    agentPid: flagInt(flags, 'agent-pid', undefined),
    notes: flagText(flags, 'notes', 'notes')
  };
}

function printStatus(status, dbPath) {
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : '-');
  const short = (text, max = 54) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
  console.log('');
  console.log('T9 deploy ledger');
  console.log(`  db:   ${dbPath}`);
  console.log(`  now:  ${when(status.now)}`);
  console.log(
    `  eta accuracy (last 20 shipped): ${
      status.avgEtaDeltaMinutes == null
        ? 'no data'
        : `${status.avgEtaDeltaMinutes > 0 ? '+' : ''}${status.avgEtaDeltaMinutes} min vs estimate`
    }`
  );
  console.log('');

  if (status.active) {
    const a = status.active;
    console.log(`ACTIVE  ${a.id}  ${a.agent} / ${a.model}`);
    console.log(
      `        ${short(a.task)} | ${a.scope} | eta ${a.etaMinutes}m | ` +
        `started ${when(a.startedAt)} | heartbeat ${a.heartbeatAgeSeconds}s ago | ` +
        `lease ${Math.round((a.leaseSecondsLeft ?? 0) / 60)}m left`
    );
  } else {
    console.log('ACTIVE  (none)');
  }

  console.log('');
  console.log(`QUEUE   ${status.queueDepth} waiting`);
  if (status.queue.length === 0) {
    console.log('        (empty)');
  } else {
    for (const item of status.queue) {
      console.log(
        `  ${item.position}. ${item.id}  ${item.agent} / ${item.model}  ` +
          `eff ${item.effectivePriority}  eta ${item.etaMinutes}m  waited ${item.waitedMinutes}m`
      );
      console.log(`     ${short(item.task)} [${item.scope}]`);
    }
  }

  console.log('');
  console.log('RECENT');
  for (const item of status.recent.slice(0, 8)) {
    const stamp = when(item.finishedAt ?? item.createdAt);
    console.log(
      `  ${item.status.toUpperCase().padEnd(9)} ${item.id}  ${item.agent} / ${item.model}  ${stamp}`
    );
    console.log(
      `            ${short(item.task)}${item.error ? ` | ${short(item.error, 70)}` : ''}`
    );
  }

  const liveSessions = status.sessions.filter((session) => session.alive);
  if (liveSessions.length > 0) {
    console.log('');
    console.log('SESSIONS');
    for (const session of liveSessions) {
      console.log(
        `  ${session.id}  ${session.agent} / ${session.model}  ` +
          `arrived ${when(session.firstSeen)}  last ${when(session.lastSeen)}  ` +
          `deploys ${session.deployCount}`
      );
    }
  }
  console.log('');
}

/* -------------------------------------------------------------------- main */

async function main(argv) {
  const { positional, flags } = parseArgv(argv);
  const command = positional[0] ?? 'status';
  const dbPath = flagText(flags, 'db', 'db') ?? defaultDbPath();

  if (flags.help || command === 'help') {
    printHelp();
    return 0;
  }

  if (command === 'path') {
    console.log(dbPath);
    return 0;
  }

  if (command === 'heartbeat-loop') {
    assertKnown(
      flags,
      ['id', 'token', 'interval', 'max-hours', 'parent-pid', 'lease-minutes', 'phase'],
      command
    );
    await heartbeatLoop({
      dbPath,
      workId: requireFlag(flags, 'id', 'work id'),
      token: requireFlag(flags, 'token', 'token'),
      intervalSeconds: flagInt(flags, 'interval', 20),
      maxHours: flagInt(flags, 'max-hours', 8),
      parentPid: flagInt(flags, 'parent-pid', undefined),
      leaseMinutes: flagInt(flags, 'lease-minutes', DEFAULT_LEASE_MINUTES),
      phase: flagText(flags, 'phase', 'phase') ?? 'heartbeat'
    });
    return 0;
  }

  const db = openLedger(dbPath);
  const now = Date.now();
  try {
    if (command === 'init') {
      assertKnown(flags, [], command);
      console.log(JSON.stringify({ ok: true, dbPath, schemaVersion: SCHEMA_VERSION }, null, 2));
      return 0;
    }

    if (command === 'request') {
      assertKnown(
        flags,
        [
          'agent',
          'model',
          'task',
          'why',
          'eta',
          'scope',
          'priority',
          'emergency',
          'session',
          'worktree',
          'branch',
          'commit',
          'git-dirty',
          'git-clean',
          'agent-pid',
          'notes'
        ],
        command
      );
      const result = requestWork(db, requestFromFlags(flags), now);
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log('');
        console.log(`Work order ${result.workId} queued.`);
        console.log(
          `  agent/model: ${flagText(flags, 'agent', 'agent')} / ${flagText(flags, 'model', 'model')}`
        );
        console.log(`  position:    ${result.position ?? '-'} of ${result.queueDepth}`);
        console.log(`  estimate:    ${result.etaAheadMinutes}m of work ahead`);
        console.log(`  createdAt:   ${new Date(result.createdAt).toLocaleString()}`);
        console.log('');
        console.log('The token is only printed with --json; deploy.ps1 keeps it in memory.');
      }
      return 0;
    }

    if (command === 'claim') {
      assertKnown(flags, ['id', 'token', 'lease-minutes'], command);
      const result = claimWork(
        db,
        {
          workId: requireFlag(flags, 'id', 'work id'),
          token: requireFlag(flags, 'token', 'token'),
          leaseMinutes: flagInt(flags, 'lease-minutes', DEFAULT_LEASE_MINUTES)
        },
        now
      );
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else if (result.state === 'active') {
        console.log(
          `ACTIVE ${result.workId} (run ${result.runId}) until ${new Date(result.leaseUntil).toLocaleTimeString()}`
        );
      } else {
        console.log(
          `WAITING ${result.workId} - position ${result.position ?? '-'} of ${result.queueDepth}, ` +
            `about ${result.etaAheadMinutes}m of work ahead` +
            (result.active ? `; ${result.active.id} is active` : '')
        );
      }
      return 0;
    }

    if (command === 'heartbeat') {
      assertKnown(flags, ['id', 'token', 'phase', 'lease-minutes'], command);
      const result = heartbeatWork(
        db,
        {
          workId: requireFlag(flags, 'id', 'work id'),
          token: requireFlag(flags, 'token', 'token'),
          phase: flagText(flags, 'phase', 'phase') ?? 'working',
          leaseMinutes: flagInt(flags, 'lease-minutes', DEFAULT_LEASE_MINUTES)
        },
        now
      );
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result.state} ${result.workId} heartbeat ok`);
      return 0;
    }

    if (command === 'finish') {
      assertKnown(
        flags,
        ['id', 'token', 'outcome', 'mode', 'build-id', 'error', 'evidence'],
        command
      );
      const result = finishWork(
        db,
        {
          workId: requireFlag(flags, 'id', 'work id'),
          token: requireFlag(flags, 'token', 'token'),
          outcome: requireFlag(flags, 'outcome', 'outcome'),
          mode: flagText(flags, 'mode', 'mode'),
          buildId: flagText(flags, 'build-id', 'build id'),
          error: flagText(flags, 'error', 'error'),
          evidence: flagText(flags, 'evidence', 'evidence')
        },
        now
      );
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          `${result.status.toUpperCase()} ${result.workId}` +
            (result.durationMinutes != null
              ? ` in ${result.durationMinutes}m (eta ${result.etaMinutes}m, ${result.etaDeltaMinutes >= 0 ? '+' : ''}${result.etaDeltaMinutes}m)`
              : '')
        );
      }
      return 0;
    }

    if (command === 'status') {
      assertKnown(flags, ['limit'], command);
      const result = getStatus(db, { now, limit: flagInt(flags, 'limit', 12) });
      result.dbPath = dbPath;
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else printStatus(result, dbPath);
      return 0;
    }

    if (command === 'recover') {
      assertKnown(flags, ['max-heartbeat-age', 'force'], command);
      const maxHeartbeatAge = flagInt(flags, 'max-heartbeat-age', 0);
      if (maxHeartbeatAge < 0) {
        throw new LedgerError('--max-heartbeat-age cannot be negative');
      }
      // The default recovery only reaps orders whose lease has already
      // expired. The heartbeat override can expire a LIVE order, so it is an
      // operator action: it needs --force and a sane floor. Without this, any
      // agent could run `recover --max-heartbeat-age 1` and clear the deploy
      // that is ahead of it in the queue.
      if (maxHeartbeatAge > 0) {
        if (!flags.force) {
          throw new LedgerError(
            'recover --max-heartbeat-age can expire an active deploy; pass --force after confirming that agent is gone'
          );
        }
        if (maxHeartbeatAge < 5) {
          throw new LedgerError('--max-heartbeat-age must be at least 5 minutes');
        }
      }
      const expired = reap(db, now, maxHeartbeatAge > 0 ? maxHeartbeatAge * 60000 : null);
      if (flags.json) console.log(JSON.stringify({ ok: true, expired }, null, 2));
      else {
        console.log(`recovered ${expired.length} stale work order(s)`);
        for (const item of expired) console.log(`  ${item.id}  ${item.reason}`);
      }
      return 0;
    }

    if (command === 'event') {
      assertKnown(flags, ['id', 'run', 'level', 'phase', 'message'], command);
      const result = addEvent(
        db,
        {
          workId: flagText(flags, 'id', 'work id'),
          runId: flagText(flags, 'run', 'run id'),
          level: flagText(flags, 'level', 'level') ?? 'info',
          phase: flagText(flags, 'phase', 'phase') ?? 'note',
          message: requireFlag(flags, 'message', 'message')
        },
        now
      );
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`event recorded (${result.level}/${result.phase})`);
      return 0;
    }

    if (command === 'session-end') {
      assertKnown(flags, ['session'], command);
      const result = sessionEnd(
        db,
        { sessionId: requireFlag(flags, 'session', 'session id') },
        now
      );
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`session ${result.sessionId} closed`);
      return 0;
    }

    throw new LedgerError(`unknown command: ${command}`, 2);
  } finally {
    closeLedger(db, dbPath);
  }
}

function printHelp() {
  console.log(`
T9 deploy ledger - one SQLite queue for every desktop deploy.

  node deploy-ledger.mjs request --agent NAME --model MODEL --task TEXT --why TEXT
                                --eta MINUTES [--scope app|go|both|docs]
                                [--priority 0..100] [--emergency]
                                [--session ID] [--worktree PATH] [--branch NAME]
                                [--commit SHA] [--git-dirty|--git-clean] [--agent-pid PID]
                                [--notes TEXT] [--json]

  node deploy-ledger.mjs claim   --id WO --token TOKEN [--lease-minutes N] [--json]
  node deploy-ledger.mjs heartbeat --id WO --token TOKEN [--phase TEXT] [--json]
  node deploy-ledger.mjs finish  --id WO --token TOKEN --outcome shipped|failed|cancelled
                                [--mode installed|staged] [--build-id ID]
                                [--evidence FILE] [--error TEXT] [--json]
  node deploy-ledger.mjs status  [--limit N] [--json]
  node deploy-ledger.mjs recover [--max-heartbeat-age MINUTES --force] [--json]
  node deploy-ledger.mjs event   --message TEXT [--id WO] [--phase TEXT] [--level info|warn|error]
  node deploy-ledger.mjs session-end --session ID
  node deploy-ledger.mjs path
  node deploy-ledger.mjs init

Global: --db PATH (or T9_LEDGER_DB), --json, --help

Queue rules:
  - one active deploy at a time (partial unique index)
  - normal work is FIFO; priority 50 is the default
  - priority ages +1/minute, capped at +50, so low priority cannot starve
  - priority above 60 requires --emergency
  - a queued order without a heartbeat for 15 minutes expires
  - an active order whose lease expires is marked expired and the queue moves on
  - recover --max-heartbeat-age N can also expire an active order whose
    heartbeat is older than N minutes (operator recovery for a crashed agent)
`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const code = error instanceof LedgerError ? error.exitCode : 1;
      console.error(`deploy-ledger: ${error.message}`);
      process.exitCode = code;
    }
  );
}
