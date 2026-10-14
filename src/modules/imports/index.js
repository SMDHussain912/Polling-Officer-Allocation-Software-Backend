'use strict';

/**
 * Stage: imports — HTTP routes (session-authenticated).
 *
 *   POST /api/imports/personnel   upload one proforma workbook (base64 JSON)
 *   GET  /api/imports/batches     recent import batches (traceability)
 *   GET  /api/imports/batches/:id/personnel
 *          accepted personnel rows in one batch (all proforma columns)
 *   GET  /api/imports/batches/:id/rejected
 *          rejected rows stored for one batch (status + reasons + raw values)
 *
 * Upload format: { "fileName": "...", "dataBase64": "<file as base64>" }.
 * (JSON instead of multipart so no extra upload package is needed; the file
 * content never touches disk.)
 *
 * Both accepted AND rejected rows are stored (team decision 2026-10-14):
 * accepted -> personnel (import_status='accepted'), rejected ->
 * import_rejected_rows (import_status='rejected' semantics + reasons).
 * Every read comes from the DB; the frontend never renders a local-file
 * fallback as if it were stored data.
 *
 * Authorization: session required (router.use(requireAuth)). Role policy is
 * enforced per route with authorize(...roles):
 *   POST /personnel                 -> authority, admin
 *   GET  /batches                   -> staff, authority, admin (read-only)
 *   GET  /batches/:id/personnel     -> staff, authority, admin (read-only)
 *   GET  /batches/:id/rejected      -> staff, authority, admin (read-only)
 *
 * The personnel read endpoint uses an explicit column allow-list covering
 * every proforma column the import step stores (see import.service.js
 * PERSONNEL_COLUMNS); it never uses SELECT *.
 */

const express = require('express');
const pool = require('../../database');
const { requireAuth, authorize } = require('../../middleware/auth');
const { persistPersonnelImport, patchPersonnelExemption } = require('./import.service');
const {
  replaceMicroObservers,
  replaceTrainingLocations,
  replaceRequirements,
  createTrainingBatches,
  clearTrainingBatches,
} = require('./intake.service');
const { IntakeParseError } = require('./intake');
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
        exemptRows: result.exemptRows,
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
// Returns the FULL accepted row (all proforma columns) so Phase 1 can render
// the total uploaded data. Projection stays an EXPLICIT column list
// (never SELECT *) — the same columns the import step writes.
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

    // Full data: every proforma column stored at import time, no row cap, so
    // Phase 1 shows the same total data that is present in the database.
    // Projection stays an EXPLICIT column list (never SELECT *) and NEVER
    // selects aadhar_number / voter_id / mobile_no — that privacy rule was
    // approved for this endpoint and must not regress. Full proforma columns
    // that are safe to display are camelCase-projected for the frontend.
    const result = await pool.query(
      `SELECT id, import_batch_id, import_status, district, exempt_category,
              sl_no, employee_id, employee_name, designation, gender, age,
              languages_known, employment_sector, scale_of_pay,
              basic_pay, gazetted_status, date_of_birth, date_of_retirement,
              employment_type, enrolled_assembly_constituency, part_no_vote_sl_no,
              residence_address, residence_constituency_code,
              residence_constituency_name, work_mandal, working_constituency_code,
              working_constituency_name, native_mandal, native_constituency_code,
              native_constituency_name, previous_po_duty,
              service_in_district_4y, ph_category, criminal_case_or_eci_orders,
              exceeded_3_years, eci_ceo_order_details, remarks
         FROM personnel
        WHERE import_batch_id = $1
        ORDER BY id`,
      [id]
    );

    const personnel = result.rows.map((r) => ({
      id: r.id,
      importBatchId: r.import_batch_id,
      importStatus: r.import_status,
      district: r.district,
      exemptCategory: r.exempt_category,
      slNo: r.sl_no,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      designation: r.designation,
      gender: r.gender,
      age: r.age,
      languagesKnown: r.languages_known,
      employmentSector: r.employment_sector,
      scaleOfPay: r.scale_of_pay,
      basicPay: r.basic_pay,
      gazettedStatus: r.gazetted_status,
      dateOfBirth: r.date_of_birth,
      dateOfRetirement: r.date_of_retirement,
      employmentType: r.employment_type,
      enrolledAssemblyConstituency: r.enrolled_assembly_constituency,
      partNoVoteSlNo: r.part_no_vote_sl_no,
      residenceAddress: r.residence_address,
      residenceConstituencyCode: r.residence_constituency_code,
      residenceConstituencyName: r.residence_constituency_name,
      workMandal: r.work_mandal,
      workingConstituencyCode: r.working_constituency_code,
      workingConstituencyName: r.working_constituency_name,
      nativeMandal: r.native_mandal,
      nativeConstituencyCode: r.native_constituency_code,
      nativeConstituencyName: r.native_constituency_name,
      previousPoDuty: r.previous_po_duty,
      serviceInDistrict4y: r.service_in_district_4y,
      phCategory: r.ph_category,
      criminalCaseOrEciOrders: r.criminal_case_or_eci_orders,
      exceeded3Years: r.exceeded_3_years,
      eciCeoOrderDetails: r.eci_ceo_order_details,
      remarks: r.remarks,
    }));

    res.json({ ok: true, batch: batchResult.rows[0], count: personnel.length, personnel });
  } catch (err) {
    console.error('list batch personnel failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load personnel' });
  }
});

// Rejected rows stored for one batch (import_status='rejected' semantics).
// Returns { ok, batch, count, rejected: [{ sheetRow, employeeId, reasons,
// rawValues }] } straight from import_rejected_rows — no local fallback.
router.get(
  '/batches/:id/rejected',
  authorize('staff', 'authority', 'admin'),
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid batch id' });
    }
    try {
      const batchResult = await pool.query('SELECT * FROM import_batches WHERE id = $1', [id]);
      if (batchResult.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Batch not found' });
      }
      const result = await pool.query(
        `SELECT id, sheet_row, employee_id, reasons, raw_values
           FROM import_rejected_rows
          WHERE import_batch_id = $1
          ORDER BY sheet_row NULLS LAST, id`,
        [id]
      );
      const rejected = result.rows.map((r) => ({
        sheetRow: r.sheet_row,
        employeeId: r.employee_id,
        reasons: r.reasons || [],
        rawValues: r.raw_values || {},
        importStatus: 'rejected',
      }));
      res.json({ ok: true, batch: batchResult.rows[0], count: rejected.length, rejected });
    } catch (err) {
      console.error('list batch rejected rows failed:', err);
      res.status(500).json({ ok: false, error: 'Failed to load rejected rows' });
    }
  }
);

// Personal exemption workflow (circular p.61(a)(viii) + p.61(a)(vii) bank).
// Marker is updated only; the response never exposes medical status.
router.patch(
  '/batches/:batchId/personnel/:id/exemption',
  authorize('authority', 'admin'),
  async (req, res) => {
    const id = Number(req.params.id);
    try {
      const result = await patchPersonnelExemption({
        id,
        exemptCategory: req.body?.exemptCategory,
        note: (req.body && req.body.note) || '',
        req,
      });
      res.json({ ok: true, id: result.id });
    } catch (err) {
      console.error('patch personnel exemption failed:', err.message);
      const status = err.message === 'personnel not found' ? 404
        : err.message === 'unauthorized category' ? 400
        : err.message === 'invalid personnel id' ? 400
        : err.message === 'note must be a string up to 400 characters' ? 400
        : 400;
      res.status(status).json({ ok: false, error: err.message });
    }
  }
);

// ---------------------------------------------------------------------------
// Read endpoints for the Phase-1 intake lists (frontend tables + edit screens).
// ---------------------------------------------------------------------------
router.get('/micro-observers', authorize('staff', 'authority', 'admin'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM micro_observers ORDER BY id LIMIT 5000'
    );
    res.json({ ok: true, count: rows.length, microObservers: rows });
  } catch (err) {
    console.error('list micro observers failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load micro observers' });
  }
});

router.get('/training-locations', authorize('staff', 'authority', 'admin'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM training_locations ORDER BY mandal, location_name LIMIT 5000'
    );
    res.json({ ok: true, count: rows.length, locations: rows });
  } catch (err) {
    console.error('list training locations failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load training locations' });
  }
});

router.get('/requirements', authorize('staff', 'authority', 'admin'), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM election_requirements ORDER BY mandal LIMIT 500'
    );
    res.json({ ok: true, count: rows.length, requirements: rows });
  } catch (err) {
    console.error('list requirements failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load requirements' });
  }
});

// Batches with members (officer details + location + env date/time shown by
// the frontend Training page). Join keeps the response one query.
router.get('/training-batches', authorize('staff', 'authority', 'admin'), async (_req, res) => {
  try {
    const batchesRes = await pool.query(
      `SELECT b.id, b.batch_no, b.mandal, b.location_id,
              l.location_name, l.panchayat, l.category
         FROM training_batches b
         LEFT JOIN training_locations l ON l.id = b.location_id
        ORDER BY b.mandal, b.batch_no`
    );
    const membersRes = await pool.query(
      `SELECT m.batch_id, m.personnel_id, m.added_by_code,
              p.employee_id, p.employee_name, p.designation, p.mobile_no,
              p.email, p.work_mandal
         FROM training_batch_members m
         JOIN personnel p ON p.id = m.personnel_id
        ORDER BY p.employee_name`
    );
    const byBatch = new Map();
    for (const m of membersRes.rows) {
      if (!byBatch.has(m.batch_id)) byBatch.set(m.batch_id, []);
      byBatch.get(m.batch_id).push(m);
    }
    const batches = batchesRes.rows.map((b) => ({
      ...b,
      members: byBatch.get(b.id) || [],
    }));
    res.json({ ok: true, count: batches.length, batches });
  } catch (err) {
    console.error('list training batches failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load training batches' });
  }
});

// ---------------------------------------------------------------------------
// Phase-1 intake hub: Micro Observers / training locations / requirements.
// Same upload format as personnel: { fileName, dataBase64 }.
// Upload REPLACES the whole table (corrected file supersedes old one);
// rejected rows returned with reasons (not stored for these lists).
// ---------------------------------------------------------------------------
async function handleIntake(req, res, fn) {
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
    const result = await fn(buffer);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof IntakeParseError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err && err.statusCode === 409) {
      return res.status(409).json({ ok: false, error: err.message });
    }
    console.error('intake import failed:', err);
    res.status(500).json({ ok: false, error: 'Import failed' });
  }
}

router.post(
  '/micro-observers',
  authorize('authority', 'admin'),
  (req, res) => handleIntake(req, res, (buffer) => replaceMicroObservers({ buffer }))
);

router.post(
  '/training-locations',
  authorize('authority', 'admin'),
  (req, res) => handleIntake(req, res, (buffer) => replaceTrainingLocations({ buffer }))
);

router.post(
  '/requirements',
  authorize('authority', 'admin'),
  (req, res) => handleIntake(req, res, (buffer) => replaceRequirements({ buffer }))
);

// Training batches: create (code, random within mandal, <=100) / clear.
router.post(
  '/training-batches/create',
  authorize('authority', 'admin'),
  async (req, res) => {
    try {
      const result = await createTrainingBatches({ createdBy: req.session.user.id });
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err && err.statusCode === 409) {
        return res.status(409).json({ ok: false, error: err.message });
      }
      console.error('create training batches failed:', err);
      res.status(500).json({ ok: false, error: 'Batch creation failed' });
    }
  }
);

router.delete(
  '/training-batches',
  authorize('authority', 'admin'),
  async (_req, res) => {
    try {
      const result = await clearTrainingBatches();
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('clear training batches failed:', err);
      res.status(500).json({ ok: false, error: 'Clear failed' });
    }
  }
);

module.exports = router;
