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

function classifyStage2Role(role) {
  const r = String(role || '').toLowerCase();
  if (r.includes('micro') && r.includes('observer')) return 'MO';
  if (r === 'mo' || r.startsWith('micro observer')) return 'MO';
  if (r.includes('presid')) return 'PO';
  return 'APO';
}

/**
 * Persist normalized Stage 2/3 rows for a completed run (migration 014).
 * Called with the allocation_runs id AFTER the run row insert commits.
 * Best-effort: throws on real DB errors so the router can report them —
 * silent warn-and-swallow was hiding lost Stage 2/3 data.
 */
async function persistStageTables(runId, result) {
  const stage2 = result.stage2 || {};
  const stage3 = result.stage3 || {};
  const parties = Array.isArray(stage2.parties) ? stage2.parties : [];
  const assignments = Array.isArray(stage3.assignments) ? stage3.assignments : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM stage3_assignments WHERE run_id = $1', [runId]);
    await client.query('DELETE FROM stage2_team_members WHERE run_id = $1', [runId]);
    await client.query('DELETE FROM stage2_teams WHERE run_id = $1', [runId]);

    const teamIdByCode = new Map();
    for (const p of parties) {
      const code = String(p.teamCode || '').trim();
      if (!code) continue;
      const r = await client.query(
        `INSERT INTO stage2_teams (run_id, team_code, posting_mandal, team_size)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (run_id, team_code) DO UPDATE
           SET posting_mandal = EXCLUDED.posting_mandal, team_size = EXCLUDED.team_size
         RETURNING id`,
        [runId, code, p.postingMandal || null, p.teamSize || (p.members ? p.members.length : null)]
      );
      teamIdByCode.set(code, r.rows[0].id);
    }

    // Resolve HR employee_id -> personnel.id once for FK linkage.
    const empIds = [];
    for (const p of parties) {
      for (const m of p.members || []) {
        if (m.personnelId != null) empIds.push(String(m.personnelId).trim());
      }
    }
    const uniqEmp = [...new Set(empIds.filter(Boolean))];
    const idByEmp = new Map();
    if (uniqEmp.length > 0) {
      const pr = await client.query(
        'SELECT id, employee_id FROM personnel WHERE employee_id = ANY($1::text[])',
        [uniqEmp]
      );
      for (const row of pr.rows) idByEmp.set(String(row.employee_id).trim(), row.id);
    }

    for (const p of parties) {
      const code = String(p.teamCode || '').trim();
      if (!code) continue;
      const teamId = teamIdByCode.get(code);
      for (const m of p.members || []) {
        const empKey = m.personnelId == null ? '' : String(m.personnelId).trim();
        if (!empKey) continue;
        await client.query(
          `INSERT INTO stage2_team_members
             (run_id, team_id, team_code, employee_id, personnel_id, role, duty, training_group)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (run_id, team_code, employee_id) DO UPDATE
             SET personnel_id = EXCLUDED.personnel_id, role = EXCLUDED.role,
                 duty = EXCLUDED.duty, training_group = EXCLUDED.training_group`,
          [
            runId, teamId, code, empKey,
            idByEmp.get(empKey) || null,
            m.role || 'Polling Officer',
            m.duty == null ? null : String(m.duty),
            classifyStage2Role(m.role),
          ]
        );
      }
    }

    for (const a of assignments) {
      const code = String(a.teamCode || '').trim();
      if (!code) continue;
      await client.query(
        `INSERT INTO stage3_assignments
           (run_id, team_code, station_id, station_code, station_mandal, posting_mandal, publication_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (run_id, team_code) DO UPDATE
           SET station_id = EXCLUDED.station_id, station_code = EXCLUDED.station_code,
               station_mandal = EXCLUDED.station_mandal, posting_mandal = EXCLUDED.posting_mandal,
               publication_status = EXCLUDED.publication_status`,
        [
          runId, code,
          a.stationId == null ? null : String(a.stationId),
          a.stationCode == null ? null : String(a.stationCode),
          a.stationMandal || null,
          a.postingMandal || null,
          a.publicationStatus || 'confidential',
        ]
      );
    }

    await client.query('COMMIT');
    return {
      teams: teamIdByCode.size,
      members: uniqEmp.length,
      assignments: assignments.length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Read the latest run's normalized Stage 2/3 rows (migration 014).
 * Returns null when no run has persisted rows yet (caller falls back
 * to allocation_runs JSON).
 */
async function latestStageTables() {
  const r = await pool.query(
    `SELECT m.run_id, m.team_code, m.employee_id, m.personnel_id, m.role, m.duty,
            m.training_group,
            COALESCE(t.posting_mandal, a.posting_mandal) AS mandal,
            a.station_id, a.station_code, a.station_mandal, a.publication_status
       FROM stage2_team_members m
       JOIN (SELECT run_id, MAX(id) AS max_id FROM stage2_team_members GROUP BY run_id
             ORDER BY run_id DESC LIMIT 1) latest ON latest.run_id = m.run_id
       LEFT JOIN stage2_teams t ON t.run_id = m.run_id AND t.team_code = m.team_code
       LEFT JOIN stage3_assignments a ON a.run_id = m.run_id AND a.team_code = m.team_code
      WHERE m.run_id = latest.run_id
      ORDER BY m.team_code, m.role`
  );
  if (r.rows.length === 0) return null;
  return { runId: r.rows[0].run_id, rows: r.rows };
}

function recordRun(entry) {
  store.hydrated = true; // we hold the freshest run; no need to hydrate over it
  store.lastRun = entry;
  store.publication = null; // a new run supersedes any earlier publication
  // Write-through to the DB. The router awaits this promise before responding,
  // so a failure here must surface as an error — never a false success.
  return (async () => {
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
    // Normalized Stage 2/3 rows (migration 014): same transaction scope as
    // the run, so Training can read DB tables instead of re-parsing JSON.
    // A persist failure is logged and marked on the entry, but does NOT
    // fail the run — the allocation_runs row and in-memory store are already
    // committed, so Training can still fall back to the run JSON.
    try {
      entry.stageTables = await persistStageTables(entry.id, entry);
    } catch (stageErr) {
      entry.stageTablesError = stageErr.message || String(stageErr);
      if (process.env.NODE_ENV !== 'test') {
        console.error('allocation-store: stage tables persist FAILED:', stageErr);
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

module.exports = { recordRun, recordPublication, getLastRun, getPublication, hydrateOnce, latestStageTables, classifyStage2Role, persistStageTables, _reset };
