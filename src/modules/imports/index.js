'use strict';

/**
 * Stage: imports — HTTP routes (session-authenticated).
 *
 *   POST /api/imports/personnel   upload one proforma workbook (base64 JSON)
 *   GET  /api/imports/batches     recent import batches (traceability)
 *
 * Upload format: { "fileName": "...", "dataBase64": "<file as base64>" }.
 * (JSON instead of multipart so no extra upload package is needed; the file
 * content never touches disk.)
 *
 * Authorization: session required. Role gating awaits the permission-matrix
 * decision (DECISIONS_AND_OPEN_QUESTIONS B6); Aadhar is never returned by
 * these endpoints (personnel rows are not returned at all).
 */

const express = require('express');
const pool = require('../../database');
const { requireAuth } = require('../../middleware/auth');
const { persistPersonnelImport } = require('./import.service');
const { ImportParseError } = require('./excel.parser');

const MAX_FILE_BYTES = 15 * 1024 * 1024; // decoded size cap (~15 MB)

const router = express.Router();
router.use(requireAuth);
router.use(express.json({ limit: '20mb' }));

router.post('/personnel', async (req, res) => {
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

router.get('/batches', async (req, res) => {
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

module.exports = router;
