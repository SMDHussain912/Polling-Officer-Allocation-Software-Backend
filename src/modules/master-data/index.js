'use strict';

/**
 * Master data — polling-station HTTP routes (session-authenticated, role-gated).
 *
 *   POST /api/master-data/stations        import a batch of polling stations (JSON)
 *   GET  /api/master-data/stations        list stations (optional ?batchId=&district=)
 *   GET  /api/master-data/stations/batches  recent station import batches
 *
 * Input format (JSON — the official "Booths" workbook is not in the workspace;
 * see stations.validation.js for the field contract):
 *   { "fileName": "...", "stations": [ { stationId, stationNumber, stationName,
 *     mandal, district, buildingName?, street?, locality?, ward?, pinCode?,
 *     requiredOfficers? }, ... ] }
 *
 * Authorization (session required; per-route role policy mirrors imports):
 *   POST /stations        -> authority, admin
 *   GET  /stations        -> staff, authority, admin (read-only)
 *   GET  .../batches      -> staff, authority, admin (read-only)
 *
 * polling_stations holds no sensitive personal data; only the allow-listed
 * columns are returned.
 */

const express = require('express');
const { requireAuth, authorize } = require('../../middleware/auth');
const { persistStationImport, listStations } = require('./stations.service');

const MAX_STATIONS = 5000;

const router = express.Router();
router.use(requireAuth);
router.use(express.json({ limit: '20mb' }));

router.post('/stations', authorize('authority', 'admin'), async (req, res) => {
  const { fileName, stations } = req.body || {};
  if (!fileName || typeof fileName !== 'string') {
    return res.status(400).json({ ok: false, error: 'fileName is required' });
  }
  if (!Array.isArray(stations)) {
    return res.status(400).json({ ok: false, error: 'stations must be an array' });
  }
  if (stations.length === 0) {
    return res.status(400).json({ ok: false, error: 'stations array is empty' });
  }
  if (stations.length > MAX_STATIONS) {
    return res.status(413).json({ ok: false, error: `Too many stations (max ${MAX_STATIONS})` });
  }

  try {
    const result = await persistStationImport({
      fileName,
      stations,
      importedBy: req.session.user.id,
    });
    res.json({
      ok: true,
      batch: {
        id: result.batchId,
        kind: 'stations',
        totalRows: result.totalRows,
        acceptedRows: result.acceptedRows,
        rejectedRows: result.rejectedRows,
      },
      rejected: result.rejected,
    });
  } catch (err) {
    if (err && err.statusCode === 400) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('station import failed:', err);
    res.status(500).json({ ok: false, error: 'Import failed' });
  }
});

router.get('/stations', authorize('staff', 'authority', 'admin'), async (req, res) => {
  const batchId = req.query.batchId ? Number.parseInt(req.query.batchId, 10) : undefined;
  if (req.query.batchId && (!Number.isSafeInteger(batchId) || batchId <= 0)) {
    return res.status(400).json({ ok: false, error: 'Invalid batchId' });
  }
  try {
    const { count, stations } = await listStations({
      batchId,
      district: req.query.district,
      limit: req.query.limit ? Number.parseInt(req.query.limit, 10) : undefined,
    });
    res.json({ ok: true, count, stations });
  } catch (err) {
    console.error('list stations failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load stations' });
  }
});

router.get('/stations/batches', authorize('staff', 'authority', 'admin'), async (req, res) => {
  const pool = require('../../database');
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.file_name, b.total_rows, b.accepted_rows, b.rejected_rows,
              b.status, b.kind, b.imported_at, u.username AS imported_by
         FROM import_batches b
         LEFT JOIN users u ON u.id = b.imported_by
        WHERE b.kind = 'stations'
        ORDER BY b.id DESC
        LIMIT 50`
    );
    res.json({ ok: true, batches: rows });
  } catch (err) {
    console.error('list station batches failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load station batches' });
  }
});

module.exports = router;

