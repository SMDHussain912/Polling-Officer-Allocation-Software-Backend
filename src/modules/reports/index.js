'use strict';

/**
 * Reports router — read-only summaries from the last allocation + the two
 * import pipelines. No write surfaces, no sensitive personnel fields.
 *
 *   GET /api/reports/allocation   last run: stage summaries, party/station
 *                                 counts, MO assignments, publication state
 *   GET /api/reports/summary      import data counts (personnel/stations by
 *                                 mandal + designation), batch traceability
 *
 * Personnel rows are never returned — only aggregated counts grouped by
 * non-sensitive columns. Members listed under a party expose name + role
 * only (no contacts, Aadhaar, EPIC).
 *
 * Authorization: session required. Allocation details are deployment-sensitive
 * (Stage 3 confidentiality) -> authorize('authority','admin'). The summary
 * endpoint is read-only counts -> all authenticated roles.
 */

const express = require('express');
const pool = require('../../database');
const { requireAuth, authorize } = require('../../middleware/auth');
const { getLastRun, getPublication } = require('../randomization/allocation-store');

const router = express.Router();
router.use(requireAuth);

// --- Allocation report: last completed run + publication state ---------------
router.get('/allocation', authorize('authority', 'admin'), (req, res) => {
  const last = getLastRun();
  if (!last) {
    return res.json({ ok: true, run: null, note: 'No allocation run yet in this session of the server.' });
  }
  const parties = (last.stage2 && last.stage2.parties) || [];
  const assignments = (last.stage3 && last.stage3.assignments) || [];
  const microObservers = parties.reduce(function (n, p) {
    return n + (p.members || []).filter(function (m) { return m.isMicroObserver; }).length;
  }, 0);

  res.json({
    ok: true,
    runAt: last.runAt,
    runBy: last.runBy,
    stage1: summarizeStage1(last.stage1),
    stage2: {
      status: last.stage2 && last.stage2.status,
      parties: parties.map(function (p) {
        return {
          teamCode: p.teamCode,
          postingMandal: p.postingMandal,
          teamSize: p.teamSize,
          operationalSize: p.operationalSize,
          microObserver: !!p.microObserverPersonnelId,
          members: (p.members || []).map(function (m) {
            return { name: m.name, role: m.role, isMicroObserver: !!m.isMicroObserver };
          }),
        };
      }),
      microObserversAssigned: (last.stage2 && last.stage2.microObserversAssigned) || 0,
      unmetRequirements: (last.stage2 && last.stage2.unmetRequirements) || [],
    },
    stage3: {
      status: last.stage3 && last.stage3.status,
      publicationStatus: last.stage3 && last.stage3.publicationStatus,
      assignments: assignments.map(function (a) {
        return { teamCode: a.teamCode, stationId: a.stationId, stationCode: a.stationCode };
      }),
    },
    counts: {
      parties: parties.length,
      assignments: assignments.length,
      microObservers: microObservers,
    },
    publication: getPublication(),
  });
});

function summarizeStage1(stage1) {
  if (!stage1) return null;
  return {
    status: stage1.status,
    runId: stage1.runId,
    requiredCount: stage1.requiredCount,
    reserveCount: stage1.reserveCount,
    selectedCount: (stage1.results || []).length,
  };
}

// --- Data summary: import counts, no personnel detail ------------------------
router.get('/summary', async (req, res) => {
  try {
    const batches = await pool.query(
      "SELECT id, file_name, kind, total_rows, accepted_rows, status, imported_at " +
      "FROM import_batches ORDER BY id DESC LIMIT 20"
    );
    const personnelByMandal = await pool.query(
      "SELECT district, work_mandal AS mandal, COUNT(*) AS count " +
      "FROM personnel GROUP BY district, work_mandal ORDER BY district, work_mandal"
    );
    const personnelByDesignation = await pool.query(
      "SELECT designation, COUNT(*) AS count FROM personnel GROUP BY designation ORDER BY designation"
    );
    const stationsByMandal = await pool.query(
      "SELECT district, mandal, COUNT(*) AS count " +
      "FROM polling_stations GROUP BY district, mandal ORDER BY district, mandal"
    );
    res.json({
      ok: true,
      batches: batches.rows,
      personnelByMandal: personnelByMandal.rows,
      personnelByDesignation: personnelByDesignation.rows,
      stationsByMandal: stationsByMandal.rows,
    });
  } catch (err) {
    console.error('reports summary failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to build summary' });
  }
});

module.exports = router;

