'use strict';

/**
 * Stage: imports — persistence for a personnel import.
 *
 * One import = one import_batches row + accepted rows in personnel +
 * rejected rows in import_rejected_rows, written atomically (single
 * transaction). Rejected rows carry import_status='rejected' semantics via
 * their own table + the reasons array, so the frontend always renders stored
 * DB data (never a local-file fallback).
 *
 * District is stamped per the confirmed single-district scope (Kakinada).
 */

const pool = require('../../database');
const { parseProformaWorkbook } = require('./excel.parser');
const { validateRows } = require('./validation');
const { resolveExemption } = require('./exemption.mapping');

const IMPORT_DISTRICT = 'Kakinada';

// Personnel columns written from the sheet (proforma fields only; scope and
// control columns are set by the import itself).
const PERSONNEL_COLUMNS = [
  'sl_no', 'employee_id', 'employee_name', 'designation', 'gender', 'age',
  'aadhar_number', 'languages_known', 'employment_sector', 'scale_of_pay',
  'basic_pay', 'gazetted_status', 'date_of_birth', 'date_of_retirement',
  'employment_type', 'enrolled_assembly_constituency', 'part_no_vote_sl_no',
  'voter_id', 'residence_address', 'residence_constituency_code',
  'residence_constituency_name', 'work_mandal', 'working_constituency_code',
  'working_constituency_name', 'native_mandal', 'native_constituency_code',
  'native_constituency_name', 'previous_po_duty', 'mobile_no',
  'service_in_district_4y', 'ph_category', 'criminal_case_or_eci_orders',
  'exceeded_3_years', 'eci_ceo_order_details', 'remarks',
];

const INSERT_SQL = `
  INSERT INTO personnel (
    import_batch_id, import_status, district, exempt_category, ${PERSONNEL_COLUMNS.join(', ')}
  ) VALUES ($1, 'accepted', $2, $3, ${PERSONNEL_COLUMNS.map((_, i) => `$${i + 4}`).join(', ')})
`;

/**
 * persistPersonnelImport({ fileName, buffer, importedBy }) -> batch summary
 * Throws ImportParseError (400) for unreadable files; other errors propagate
 * as 500s and roll back the transaction.
 */
async function persistPersonnelImport({ fileName, buffer, importedBy }) {
  const { sheetInfo, rows } = parseProformaWorkbook(buffer);
  const { accepted, rejected } = validateRows(rows);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batchResult = await client.query(
      `INSERT INTO import_batches
         (file_name, imported_by, department_name, gad_department_code, ddo_code,
          total_rows, accepted_rows, rejected_rows, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress')
       RETURNING id`,
      [
        fileName,
        importedBy ?? null,
        sheetInfo.departmentName,
        sheetInfo.gadDepartmentCode,
        sheetInfo.ddoCode,
        accepted.length + rejected.length,
        accepted.length,
        rejected.length,
      ]
    );
    const batchId = batchResult.rows[0].id;

    const dept = sheetInfo.departmentName;
    let exemptCount = 0;
    for (const record of accepted) {
      // Circular p.61 exemption resolution (sheet Department + row Designation).
      // Never blocks the import: markings land in exempt_category and Stage 1
      // excludes them from the pool; the authority reviews them before running.
      const hit = resolveExemption(dept, record.designation);
      const exemptCategory = hit ? hit.category : null;
      if (hit) exemptCount += 1;
      const values = PERSONNEL_COLUMNS.map((column) => record[column] ?? null);
      await client.query(INSERT_SQL, [batchId, IMPORT_DISTRICT, exemptCategory, ...values]);
    }

    // Team decision 2026-10-14: rejected rows are stored too (same batch,
    // same transaction) in import_rejected_rows with reasons, so the frontend
    // always renders stored DB data and never a local-file fallback.
    for (const rej of rejected) {
      const rawRow = rows.find((r) => r.sheetRow === rej.sheetRow);
      await client.query(
        `INSERT INTO import_rejected_rows
           (import_batch_id, sheet_row, employee_id, reasons, raw_values)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          batchId,
          rej.sheetRow ?? null,
          rej.employeeId ?? null,
          JSON.stringify(rej.reasons || []),
          JSON.stringify((rawRow && rawRow.values) || {}),
        ]
      );
    }

    await client.query(
      `UPDATE import_batches SET status = 'completed' WHERE id = $1`,
      [batchId]
    );
    await client.query('COMMIT');

    return {
      batchId,
      totalRows: accepted.length + rejected.length,
      acceptedRows: accepted.length,
      rejectedRows: rejected.length,
      exemptRows: exemptCount,
      rejected,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark (or clear) a single personnel record's official exemption status.
 *
 *   POST /api/imports/personnel/:id/exemption   { exemptCategory, note }
 *
 *  - `exemptCategory` = an official EXEMPT_CATEGORY value, or
 *    'pending_authority_confirmation' (bank p.61(a)(vii)).
 *  - `note` is an audit-only reason (never returned in the personnel response).
 *
 * Writes the personnel row AND an append-only audit record in one transaction.
 * Sensitive categories ('pregnant', 'breastfeeding') are stored; existing read
 * endpoints mask them with the generic 'exempt' label.
 *
 * 400: unknown/unauthorized category, negative id, note > 400 chars.
 * 404: personnel not found.
 */
async function patchPersonnelExemption({ id, exemptCategory, note = '', req } = {}) {
  if (!['pregnant', 'breastfeeding', 'bank_rural_single_officer', 'veterinary_staff', 'health_medical', 'nurse_anm', 'ayush_medical', 'all_india_radio', 'doordarshan', 'bsnl_mtnl_ops', 'pending_authority_confirmation', null].includes(exemptCategory)) {
    throw new Error('unauthorized category');
  }
  if (typeof note !== 'string' || note.length > 400) {
    throw new Error('note must be a string up to 400 characters');
  }
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error('invalid personnel id');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query(
      `SELECT id, employee_id, exempt_category, import_batch_id
         FROM personnel WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (row.rows.length === 0) {
      throw new Error('personnel not found');
    }
    const personnel = row.rows[0];
    const oldCategory = personnel.exempt_category;

    const marked = exemptCategory === null || exemptCategory === 'pending_authority_confirmation' || exemptCategory === 'health_medical' || exemptCategory === 'nurse_anm' || exemptCategory === 'ayush_medical' || exemptCategory === 'veterinary_staff' || exemptCategory === 'all_india_radio' || exemptCategory === 'doordarshan' || exemptCategory === 'bsnl_mtnl_ops';

    await client.query(
      `INSERT INTO personnel_exemptions
         (personnel_id, employee_id, new_exempt_category, old_exempt_category, reason, requested_by_user_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, personnel.employee_id, exemptCategory, oldCategory, 'authority_mark', (req && req.session && req.session.user && req.session.user.id) || null, note]
    );
    await client.query(
      `UPDATE personnel
         SET exempt_category = $1
         WHERE id = $2`,
      [exemptCategory, id]
    );
    await client.query('COMMIT');
    return { ok: true, id, profileId: personnel.id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { persistPersonnelImport, patchPersonnelExemption, IMPORT_DISTRICT };

