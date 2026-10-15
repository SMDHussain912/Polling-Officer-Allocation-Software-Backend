'use strict';

/**
 * In-memory allocation store (shared by the randomization router + reports).
 *
 * Holds ONLY the most recent completed run and its publish record. Nothing
 * sensitive is stored here — the orchestrator never reads Aadhaar / voter ID /
 * mobile columns, so they cannot leak in.
 *
 * This store is a read-through cache over the durable allocation_runs /
 * allocation_publications tables (migration 012). POST /run and POST /publish
 * write through to the DB; on a cold start (e.g. backend restart) the first
 * getLastRun()/getPublication() hydrates from the latest DB row, so Stage
 * 1/2/3 results survive restarts.
 */

const pool = require('../../database');

const store = {
  lastRun: null,      // { id?, runAt, runBy, stage1, stage2, stage3, auditEvents }
  publication: null,  // { publishedStage3, confirmedBy, confirmedAt }
  hydrated: false,
};

function rowToRun(r) {
  return {
    id: r.id,
    runAt: r.run_at instanceof Date ? r.run_at.toISOString() : r.run_at,
    runBy: { id: r.run_by_id, username: r.run_by_username, role: r.run_by_role },
    stage1: r.stage1,
    stage2: r.stage2,
    stage3: r.stage3,
    auditEvents: r.audit_events || [],
  };
}

async function hydrateOnce() {
  if (store.hydrated) return;
  store.hydrated = true;
  try {
    const r = await pool.query(
      'SELECT id, run_at, run_by_id, run_by_username, run_by_role,' +
      ' stage1, stage2, stage3, audit_events' +
      ' FROM allocation_runs ORDER BY id DESC LIMIT 1'
    );
    if (r.rows.length === 0) return;
    store.lastRun = rowToRun(r.rows[0]);
    const p = await pool.query(
      'SELECT published_stage3, confirmed_by_id, confirmed_by_username, confirmed_at' +
      ' FROM allocation_publications WHERE run_id = $1 ORDER BY id DESC LIMIT 1',
      [r.rows[0].id]
    );
    if (p.rows.length > 0) {
      const row = p.rows[0];
      store.publication = {
        publishedStage3: row.published_stage3,
        confirmedBy: { id: row.confirmed_by_id, username: row.confirmed_by_username },
        confirmedAt: row.confirmed_at instanceof Date ? row.confirmed_at.toISOString() : row.confirmed_at,
      };
    }
  } catch (err) {
    // Migration 012 not applied yet (or DB down): stay memory-only, never crash.
    if (process.env.NODE_ENV !== 'test') {
      console.warn('allocation-store: DB hydrate skipped (' + (err.message || err) + ')');
    }
  }
}

function recordRun(entry) {
  store.hydrated = true; // we hold the freshest run; no need to hydrate over it
  store.lastRun = entry;
  store.publication = null; // a new run supersedes any earlier publication
  // Write-through to the DB (fire-and-forget from the router's perspective —
  // the router awaits this promise before responding).
  return (async () => {
    try {
      const r = await pool.query(
        'INSERT INTO allocation_runs' +
        ' (run_by_id, run_by_username, run_by_role, stage1, stage2, stage3, audit_events)' +
        ' VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, run_at',
        [
          (entry.runBy && entry.runBy.id) || null,
          (entry.runBy && entry.runBy.username) || null,
          (entry.runBy && entry.runBy.role) || null,
          JSON.stringify(entry.stage1 || {}),
          JSON.stringify(entry.stage2 || {}),
          JSON.stringify(entry.stage3 || {}),
          JSON.stringify(entry.auditEvents || []),
        ]
      );
      entry.id = r.rows[0].id;
      if (!entry.runAt) entry.runAt = r.rows[0].run_at instanceof Date ? r.rows[0].run_at.toISOString() : r.rows[0].run_at;
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('allocation-store: DB persist skipped (' + (err.message || err) + ')');
      }
    }
    return store.lastRun;
  })();
}

function recordPublication(publishedStage3, confirmedBy) {
  if (!store.lastRun) return null;
  store.publication = {
    publishedStage3: publishedStage3,
    confirmedBy: confirmedBy,
    confirmedAt: new Date().toISOString(),
  };
  return (async () => {
    try {
      if (store.lastRun.id) {
        await pool.query(
          'INSERT INTO allocation_publications' +
          ' (run_id, published_stage3, confirmed_by_id, confirmed_by_username)' +
          ' VALUES ($1,$2,$3,$4)',
          [
            store.lastRun.id,
            JSON.stringify(publishedStage3),
            (confirmedBy && confirmedBy.id) || null,
            (confirmedBy && confirmedBy.username) || null,
          ]
        );
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('allocation-store: DB publication persist skipped (' + (err.message || err) + ')');
      }
    }
    return store.publication;
  })();
}

function getLastRun() { return store.lastRun; }
function getPublication() { return store.publication; }

/** Test seam: reset memory state (DB untouched). */
function _reset() {
  store.lastRun = null;
  store.publication = null;
  store.hydrated = false;
}

module.exports = { recordRun, recordPublication, getLastRun, getPublication, hydrateOnce, _reset };
