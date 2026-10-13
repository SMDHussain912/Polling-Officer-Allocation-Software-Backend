'use strict';

/**
 * Stage: imports — row validation (pure, no DB).
 *
 * Validation rules (kept deliberately minimal; no invented official rules):
 *   - employee_name is required (a person cannot be identified without it);
 *   - employee_id is required (stable identifier for dedupe and Stage 1);
 *   - duplicate employee_id WITHIN one file -> the later rows are rejected
 *     (cross-batch dedupe is an open question, deliberately not enforced);
 *   - date columns must be blank or parse as dd.mm.yyyy (or a real Date
 *     cell); anything else rejects the row with an explicit reason.
 * Anything the proforma allows is preserved as-is; unknown values are not
 * filtered here.
 */

const DATE_FIELDS = ['date_of_birth', 'date_of_retirement'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Returns { value: 'YYYY-MM-DD' | null } or { error: 'unparseable_date' }. */
function normalizeDate(value) {
  if (value === '' || value === null || value === undefined) {
    return { value: null };
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      value: `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`,
    };
  }
  const match = String(value).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return { error: 'unparseable_date' };
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return { error: 'unparseable_date' };
  }
  return { value: `${year}-${pad2(month)}-${pad2(day)}` };
}

/**
 * validateRows(rows) -> { accepted, rejected }
 *   accepted: [{ <column>: value, ..., date_of_birth?: 'YYYY-MM-DD' }]
 *   rejected: [{ sheetRow, employeeId, reasons: [codes] }]
 */
function validateRows(rows) {
  const accepted = [];
  const rejected = [];
  const seenIds = new Map(); // employee_id -> first sheetRow

  for (const row of rows) {
    const { sheetRow, values } = row;
    const reasons = [];

    const employeeId = String(values.employee_id ?? '').trim();
    const employeeName = String(values.employee_name ?? '').trim();

    if (!employeeName) reasons.push('employee_name_required');
    if (!employeeId) reasons.push('employee_id_required');

    const record = { ...values, employee_id: employeeId, employee_name: employeeName };

    for (const field of DATE_FIELDS) {
      const result = normalizeDate(values[field]);
      if (result.error) {
        reasons.push(`${field}_unparseable`);
        record[field] = null;
      } else {
        record[field] = result.value;
      }
    }

    if (employeeId) {
      if (seenIds.has(employeeId)) {
        reasons.push('duplicate_employee_id_in_file');
      } else {
        seenIds.set(employeeId, sheetRow);
      }
    }

    if (reasons.length > 0) {
      rejected.push({ sheetRow, employeeId: employeeId || null, reasons });
    } else {
      accepted.push(record);
    }
  }

  return { accepted, rejected };
}

module.exports = { validateRows, normalizeDate };
