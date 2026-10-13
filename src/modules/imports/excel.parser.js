'use strict';

/**
 * Stage: imports — Excel parsing for the Employees Data Proforma.
 *
 * Pure functions only (no DB, no express). Locates the header row (row 5 of
 * the template), maps columns by their actual header text, extracts the
 * per-sheet header fields (department name, GAD code, DDO code), and yields
 * raw row values keyed by the personnel column names from migration 002.
 */

const XLSX = require('xlsx');

class ImportParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportParseError';
  }
}

/** Normalized header text (lowercase, whitespace collapsed) -> DB column. */
const HEADER_MAP = {
  'sl. no.': 'sl_no',
  'employee id no.': 'employee_id',
  'employee name': 'employee_name',
  'designation': 'designation',
  'gender (m/f)': 'gender',
  'age': 'age',
  'aadhar number': 'aadhar_number',
  'languages known': 'languages_known',
  'central/ state/ psu / private/ others': 'employment_sector',
  'scale of pay': 'scale_of_pay',
  'basic pay': 'basic_pay',
  'gazetted/ non-gazetted': 'gazetted_status',
  'date of birth (dd.mm.yyyy)': 'date_of_birth',
  'date of retirement (dd.mm.yyyy)': 'date_of_retirement',
  'type of employment (regular/ out-sourcing / contract basis)': 'employment_type',
  'assembly constituency where he/she enrolled the name': 'enrolled_assembly_constituency',
  'part no. /vote sl. no.': 'part_no_vote_sl_no',
  'voter id (epic number)': 'voter_id',
  'residence address': 'residence_address',
  'residence constituency code': 'residence_constituency_code',
  'residency constituency name': 'residence_constituency_name',
  'work mandal': 'work_mandal',
  'working constituency code': 'working_constituency_code',
  'working constituency name': 'working_constituency_name',
  'native mandal': 'native_mandal',
  'native constituency code': 'native_constituency_code',
  'native constituency name': 'native_constituency_name',
  'previous worked as po/ apo/ opo': 'previous_po_duty',
  'mobile no.': 'mobile_no',
  'total service in present district from last 4 years ( in all cadres)': 'service_in_district_4y',
  'whether he/she belongs ph category (ph-%)': 'ph_category',
  'whether any criminal cases pending? or if there are any orders from eci/ ceo against the person that not participate in election':
    'criminal_case_or_eci_orders',
  'whether exceeded 3 years (yes/no)': 'exceeded_3_years',
  'if there are any order from eci/ ceo against the person that not to participate in election? (yes/no) if so, details of order no.':
    'eci_ceo_order_details',
  'remarks': 'remarks',
};

function normalizeHeader(cell) {
  return String(cell ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  return String(value).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The template carries a row of plain column numbers (1,2,3...35) right under
 * the headers. Detect and skip it so it is not treated as data.
 */
function isColumnNumberingRow(values) {
  return (
    values.sl_no === '1' &&
    values.employee_id === '2' &&
    values.employee_name === '3' &&
    values.designation === '4' &&
    values.gender === '5'
  );
}

/** Department name / GAD code / DDO code from the per-sheet header rows. */
function extractSheetInfo(grid, headerRowIndex) {
  const info = { departmentName: null, gadDepartmentCode: null, ddoCode: null };

  const titleRaw = String(grid[0] && grid[0][0] !== undefined ? grid[0][0] : '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const titleMatch = titleRaw.toLowerCase().match(/working in\s*(.*?)\s*department/);
  if (titleMatch && titleMatch[1]) {
    // Slice the captured span out of the ORIGINAL text to preserve case.
    const name = titleRaw
      .slice(titleMatch.index, titleMatch.index + titleMatch[0].length)
      .replace(/^working in\s*/i, '')
      .replace(/\s*department$/i, '')
      .replace(/[_\s]+/g, ' ')
      .trim();
    if (name) info.departmentName = name;
  }

  for (let i = 0; i < headerRowIndex; i++) {
    const row = grid[i] || [];
    for (let col = 0; col < row.length; col++) {
      const key = normalizeHeader(row[col]);
      if (key.startsWith('dept. code as per gad') || key.startsWith('dept code as per gad')) {
        const v = normalizeCell(row[col + 1]);
        if (v !== '') info.gadDepartmentCode = String(v);
      } else if (key.startsWith('ddo code')) {
        const v = normalizeCell(row[col + 1]);
        if (v !== '') info.ddoCode = String(v);
      }
    }
  }
  return info;
}

/**
 * parseProformaWorkbook(buffer) -> { sheetInfo, rows }
 *   rows: [{ sheetRow: <1-based row number>, values: { <column>: <raw value> } }]
 * Throws ImportParseError when the file is not a readable proforma.
 */
function parseProformaWorkbook(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (err) {
    throw new ImportParseError('File could not be read as an Excel workbook.');
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new ImportParseError('Workbook has no sheets.');
  }
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: '',
  });

  let headerRowIndex = -1;
  let columnMap = {};
  for (let i = 0; i < grid.length; i++) {
    const map = {};
    (grid[i] || []).forEach((cell, col) => {
      const field = HEADER_MAP[normalizeHeader(cell)];
      if (field && map[field] === undefined) map[field] = col;
    });
    if (map.employee_id !== undefined && map.employee_name !== undefined) {
      headerRowIndex = i;
      columnMap = map;
      break;
    }
  }
  if (headerRowIndex === -1) {
    throw new ImportParseError(
      'Proforma header row not found (missing "Employee ID No." / "Employee Name" columns).'
    );
  }

  const sheetInfo = extractSheetInfo(grid, headerRowIndex);

  const rows = [];
  for (let i = headerRowIndex + 1; i < grid.length; i++) {
    const gridRow = grid[i] || [];
    const values = {};
    let anyValue = false;
    for (const [field, col] of Object.entries(columnMap)) {
      const value = normalizeCell(gridRow[col]);
      values[field] = value;
      if (value !== '') anyValue = true;
    }
    if (!anyValue) continue;
    if (isColumnNumberingRow(values)) continue;
    rows.push({ sheetRow: i + 1, values });
  }

  return { sheetInfo, rows };
}

module.exports = {
  parseProformaWorkbook,
  ImportParseError,
  HEADER_MAP, // exported for tests
};

