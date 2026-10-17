'use strict';

/**
 * Stage: imports — HTTP routes (session-authenticated).
 *
 *   POST /api/imports/personnel   upload one proforma workbook (base64 JSON)
 *   GET  /api/imports/batches     recent import batches (traceability)
 *   GET  /api/imports/batches/:id/personnel
 *          full personnel rows accepted in one batch (all proforma columns)
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
 * The personnel read endpoint uses an explicit column allow-list covering
 * every proforma column the import step stores (see import.service.js
 * PERSONNEL_COLUMNS); it never uses SELECT *.
 */

const express = require('express');
const pool = require('../../database');
const { requireAuth, authorize } = require('../../middleware/auth');
const { persistPersonnelImport } = require('./import.service');
const { ImportParseError } = require('./excel.parser');

const MAX_FILE_BYTES = 100 * 1024 * 1024; // decoded size cap (~100 MB) for large Excel uploads

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

// ---- Training: PO / APO separate roster tables (work_mandal based) ----

const { buildTrainingBatches } = require('../training/po_apo.allocator');

router.get('/training/po-apo-batches', authorize('authority', 'admin'), async (req, res) => {
  try {
    // Stage 2 output (PO + APO) with work_mandal per member, joined by teamCode.
    // In production this would read the durable Stage 2 tables; for now we
    // return the latest in-memory run's parties.
    const run = require('../../randomization/allocation-store').getLastRun();
    const parties = (run && run.stage2 && run.stage2.parties) || [];

    // Optional venue override: map work_mandal -> venue (from authoritative source).
    const venueMap = req.query.venueMap
      ? JSON.parse(String(req.query.venueMap))
      : {};

    const { poBatches, apoBatches } = buildTrainingBatches(parties, venueMap);

    res.json({ ok: true, poBatches, apoBatches });
  } catch (err) {
    console.error('list training po/apo batches failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to list training batches' });
  }
});

module.exports = router;
