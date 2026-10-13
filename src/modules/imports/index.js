'use strict';

/**
 * Stage: imports — HTTP routes (session-authenticated).
 *
 *   POST /api/imports/personnel   upload one proforma workbook (base64 JSON)
 *   GET  /api/imports/batches     recent import batches (traceability)
 *   GET  /api/imports/batches/:id/personnel
 *          personnel accepted in one batch (sensitive fields excluded)
 *
 * Upload format: { "fileName": "...", "dataBase64": "<file as base64>" }.
 * (JSON instead of multipart so no extra upload package is needed; the file
 * content never touches disk.)
 *
 * Authorization: session required (router.use(requireAuth)). Role policy is
 * enforced per route with authorize(...roles):
 *   POST /personnel                 -> authority, admin
 *   GET  /batches                   -> staff, authority, admin (read-only)
 *   GET  /batches/:id/personnel     -> staff, authority, admin (read-only)
 *
 * The personnel read endpoints use an explicit column allow-list and never
 * return Aadhaar, voter ID or mobile number (see the handler below); do not
 * change them to SELECT *.
 */

const express = require('express');
const pool = require('../../database');
const { requireAuth, authorize } = require('../../middleware/auth');
const { persistPersonnelImport } = require('./import.service');
const { ImportParseError } = require('./excel.parser');

const MAX_FILE_BYTES = 15 * 1024 * 1024; // decoded size cap (~15 MB)

const router = express.Router();
router.use(requireAuth);
router.use(express.json({ limit: '20mb' }));

router.post('/personnel', authorize('authority', 'admin'), async (req, res) => {
  const { fileName, dataBase64 } = req.body || {};
  if (!fileName || typeof fileName !== 'string') {
    return res.status(400).json({ ok: false, error: 'fileName is required' });
  }
  if (!dataBase64 || typeof dataBase64 !== 'string') {
    return res.status(400).json({ ok: false, error: 'dataBase64 is required' });
  }

  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0) {
    return res.status(400).json({ ok: false, error: 'Uploaded file is empty' });
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return res.status(413).json({ ok: false, error: 'File too large (max 15 MB)' });
  }

  try {
    const result = await persistPersonnelImport({
      fileName,
      buffer,
      importedBy: req.session.user.id,
    });
    res.json({
      ok: true,
      batch: {
        id: result.batchId,
        totalRows: result.totalRows,
        acceptedRows: result.acceptedRows,
        rejectedRows: result.rejectedRows,
      },
      rejected: result.rejected,
    });
  } catch (err) {
    if (err instanceof ImportParseError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('personnel import failed:', err);
    res.status(500).json({ ok: false, error: 'Import failed' });
  }
});

router.get('/batches', authorize('staff', 'authority', 'admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, b.file_name, b.department_name, b.total_rows, b.accepted_rows,
            b.rejected_rows, b.status, b.imported_at, u.username AS imported_by
       FROM import_batches b
       LEFT JOIN users u ON u.id = b.imported_by
      ORDER BY b.id DESC
      LIMIT 50`
  );
  res.json({ ok: true, batches: rows });
});

// Personnel accepted in a single import batch (review-before-use).
// Explicit column allow-list: Aadhaar, voter ID and mobile number are NOT
// selected, so they cannot leak through the response, errors or debug output.
// 404 on an unknown batch; invalid ids -> 400.
router.get('/batches/:id/personnel', authorize('staff', 'authority', 'admin'), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid batch id' });
  }

  try {
    const batchResult = await pool.query(
      `SELECT id, file_name, department_name, total_rows, accepted_rows, status, imported_at
         FROM import_batches
        WHERE id = $1`,
      [id]
    );
    if (batchResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Import batch not found' });
    }

    const result = await pool.query(
      `SELECT id, employee_id, employee_name, designation, gender, gazetted_status,
              work_mandal, native_mandal, working_constituency_name, import_status
         FROM personnel
        WHERE import_batch_id = $1
        ORDER BY id
        LIMIT 1000`,
      [id]
    );

    // Defense-in-depth: the SQL above already selects only safe columns, but
    // we re-project explicitly so Aadhaar / voter ID / mobile can never reach
    // the response even if the query or schema changes later.
    const personnel = result.rows.map((r) => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      designation: r.designation,
      gender: r.gender,
      gazettedStatus: r.gazetted_status,
      workMandal: r.work_mandal,
      nativeMandal: r.native_mandal,
      workingConstituencyName: r.working_constituency_name,
      importStatus: r.import_status,
    }));

    res.json({ ok: true, batch: batchResult.rows[0], count: personnel.length, personnel });
  } catch (err) {
    console.error('list batch personnel failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load personnel' });
  }
});

module.exports = router;
