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
 *   - minimum age 21 [TEAM RULE, not circular]: computed from date_of_birth
 *     when present (else the Age column when numeric); anyone below 21 is
 *     rejected. The circular extract carries no age condition — this guardrail
 *     was confirmed by the team (government employees are 21+), so change
 *     MINIMUM_AGE, not the code, if the bar ever moves.
 * Anything the proforma allows is preserved as-is; unknown values are not
 * filtered here.
 */

const MINIMUM_AGE = 21;

/**
 * Full years between a YYYY-MM-DD birth date and the reference date.
 * A person born on the reference day exactly N years ago is already N.
 */
function fullYearsSince(birthIso, refDate) {
  const birth = new Date(birthIso + 'T00:00:00Z');
  let years = refDate.getUTCFullYear() - birth.getUTCFullYear();
  const month = refDate.getUTCMonth() - birth.getUTCMonth();
  if (month < 0 || (month === 0 && refDate.getUTCDate() < birth.getUTCDate())) {
    years -= 1;
  }
  return years;
}

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

    // Minimum age 21 [TEAM RULE]: DOB anchors the check; the Age column is
    // the fallback when DOB is blank. Both absent -> no basis, accept.
    const nowUtc = new Date();
    if (record.date_of_birth) {
      if (fullYearsSince(record.date_of_birth, nowUtc) < MINIMUM_AGE) {
        reasons.push('below_minimum_age');
      }
    } else {
      const ageNum = Number(String(values.age ?? '').trim());
      if (Number.isFinite(ageNum) && values.age !== '' && values.age !== null && values.age !== undefined) {
        if (ageNum < MINIMUM_AGE) reasons.push('below_minimum_age');
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

module.exports = { validateRows, normalizeDate, fullYearsSince, MINIMUM_AGE };
