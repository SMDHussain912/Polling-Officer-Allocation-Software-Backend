'use strict';

/**
 * Stage: imports — persistence for a personnel import.
 *
 * One import = one import_batches row + accepted rows in personnel, written
 * atomically (single transaction). Rejected rows are NOT stored as personnel
 * rows; they are returned to the caller as { sheetRow, reasons } so the
 * operator can fix the sheet and re-upload (batch keeps the counts).
 *
 * District is stamped per the confirmed single-district scope (Kakinada).
 */

const pool = require('../../database');
const { parseProformaWorkbook } = require('./excel.parser');
const { validateRows } = require('./validation');

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
    import_batch_id, import_status, district, ${PERSONNEL_COLUMNS.join(', ')}
  ) VALUES ($1, 'accepted', $2, ${PERSONNEL_COLUMNS.map((_, i) => `$${i + 3}`).join(', ')})
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

    for (const record of accepted) {
      const values = PERSONNEL_COLUMNS.map((column) => record[column] ?? null);
      await client.query(INSERT_SQL, [batchId, IMPORT_DISTRICT, ...values]);
    }

    await client.query(`UPDATE import_batches SET status = 'completed' WHERE id = $1`, [batchId]);
    await client.query('COMMIT');

    return {
      batchId,
      totalRows: accepted.length + rejected.length,
      acceptedRows: accepted.length,
      rejectedRows: rejected.length,
      rejected,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { persistPersonnelImport, IMPORT_DISTRICT };
