'use strict';

/** Training order allocation + print (DOCX) logic.
 *
 *  1) Allocation auto-creates PO/APO batches from the last completed run's
 *     team (allocation-store). Designation-based:
 *       - PO      = presidingEligible === true
 *       - APO     = all other officers (remaining from the team)
 *     MO invitees are NOT included. Batches are formed per mandal from the
 *     officer's duty-allocated mandal (stage-3), no cross-mandal mixing.
 *  2) Print uploads the PO or APO DOCX template, merges {{tags}} via the
 *     proven order-merge engine (docxtemplater + pizzip) with order-level +
 *     batch-level values, and stores the generated DOCX + the order record
 *     in the training_orders table (migration 011).
 *
 * Run: node --test tests/training-orders/index.test.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const pool = require('../../database');
const { getLastRun, hydrateOnce } = require('../randomization/allocation-store');
const { mergeDocx } = require('../imports/order-merge.service');

const MAX_BATCH_SIZE = 100;

/**
 * Normalize header cell -> lowercase, no spaces/punctuation.
 */
function normalizeHeader(cell) {
  return String(cell ?? '')
    .replace(/[\\r\\n]+/g, ' ')
    .replace(/[^\\w+#]/g, '')
    .toLowerCase();
}

/** Read first sheet as array-of-arrays. */
function readGrid(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  } catch (err) {
    throw new Error('File could not be read as an Excel workbook.');
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Workbook has no sheets.');
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: '',
    blankrows: false,
  });
}

function mapHeader(grid, candidates) {
  for (let i = 0; i < grid.length; i += 1) {
    const row = grid[i] || [];
    const colMap = {};
    row.forEach((cell, col) => {
      const h = normalizeHeader(cell);
      if (!h) return;
      for (const [field, aliases] of Object.entries(candidates)) {
        if (colMap[field] !== undefined) continue;
        if (aliases.some((a) => h === a || h.includes(a))) colMap[field] = col;
      }
    });
    if (Object.keys(colMap).length > 0) return { colMap, headerRow: i };
  }
  throw new Error('Header row not found.');
}

function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).replace(/[\\r\\n]+/g, ' ').replace(/\\s+/g, ' ').trim();
}

/**
 * Parse the uploaded training file (venues + schedule + date/time per group).
 * Required columns: group (PO/APO), mandal, venue, date_time (schedule).
 * Extra columns tolerated (employee_name, employee_id, location, notes).
 */
function parseTrainingData(buffer) {
  const grid = readGrid(buffer);
  const { colMap, headerRow } = mapHeader(grid, {
    group: ['group', 'poapo', 'type'],
    mandal: ['mandal'],
    venue: ['venue', 'location', 'locationname', 'venuename'],
    date_time: ['datetime', 'date', 'dateandtime', 'scheduling'],
    employee_name: ['employeename', 'name', 'employee'],
    employee_id: ['employeeid', 'empid', 'id'],
    location: ['location'],
    notes: ['notes', 'remarks'],
  });
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (let i = headerRow + 1; i < grid.length; i += 1) {
    const row = grid[i] || [];
    const get = (f) => (colMap[f] !== undefined ? normalizeCell(row[colMap[f]]) : '');
    const group = get('group') || '';
    const mandal = get('mandal') || '';
    const venue = get('venue') || '';
    const dateTime = get('date_time') || '';
    if (!group && !mandal && !venue && !dateTime) continue;
    const reasons = [];
    if (!group) reasons.push('group_required');
    if (!mandal) reasons.push('mandal_required');
    if (!venue) reasons.push('venue_required');
    if (!dateTime) reasons.push('date_time_required');
    const key = (group + '|' + mandal + '|' + venue + '|' + dateTime).toLowerCase();
    if (!reasons.length) {
      if (seen.has(key)) reasons.push('duplicate_row_in_file');
      else seen.add(key);
    }
    accepted.push({
      group,
      mandal,
      venue,
      date_time: dateTime,
      employee_name: get('employee_name') || null,
      employee_id: get('employee_id') || null,
      location: get('location') || null,
      notes: get('notes') || null,
      raw_sheet_row: i + 1,
    });
    if (reasons.length) rejected.push({ sheetRow: i + 1, group, mandal, reasons });
  }
  return { accepted, rejected };
}

/**
 * Allocate training batches from the LAST COMPLETED RUN's team rows.
 * Reads stage2.excelRows (flattened: {teamCode, mandal, role, employeeId,
 * name, designation, office}); PO = presiding role, APO = every other role.
 * Returns { batches, errors } — never throws (frontend decides what to do).
 */
async function allocateTraining({ createdBy } = {}) {
  await hydrateOnce(); // cold start (restart) -> reload latest run from the DB
  const lastRun = getLastRun();
  const teamRows = lastRun && lastRun.stage2 && Array.isArray(lastRun.stage2.excelRows)
    ? lastRun.stage2.excelRows
    : [];
  if (teamRows.length === 0) {
    return { batches: [], errors: ['No completed randomization run found. Run Stage 2 first.'] };
  }

  const client = await pool.connect();
  const batches = [];
  try {
    await client.query('BEGIN');

    // PO = presiding role; APO = every other officer role.
    const isPO = (row) => String(row.role || '').toLowerCase().includes('presid');
    const groups = { PO: [], APO: [] };
    for (const row of teamRows) {
      groups[isPO(row) ? 'PO' : 'APO'].push(row);
    }

    // Form batches per group per mandal (duty-allocated), <= MAX_BATCH_SIZE.
    for (const group of ['PO', 'APO']) {
      const members = groups[group];
      if (members.length === 0) continue;
      const byMandal = new Map();
      for (const m of members) {
        const mandal = String(m.mandal || 'UNSPECIFIED').trim() || 'UNSPECIFIED';
        if (!byMandal.has(mandal)) byMandal.set(mandal, []);
        byMandal.get(mandal).push(m);
      }
      for (const [mandal, officers] of byMandal) {
        const shuffled = officers.slice();
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
          const j = crypto.randomInt(i + 1);
          const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t;
        }
        const existing = await client.query(
          'SELECT COALESCE(MAX(batch_no), 0) AS max_no FROM training_batches WHERE mandal = $1',
          [mandal]
        );
        let batchNo = Number(existing.rows[0].max_no) + 1;
        for (let start = 0; start < shuffled.length; start += MAX_BATCH_SIZE) {
          const chunk = shuffled.slice(start, start + MAX_BATCH_SIZE);
          const b = await client.query(
            'INSERT INTO training_batches (batch_no, mandal, created_by) VALUES ($1, $2, $3) RETURNING id',
            [batchNo, mandal, createdBy == null ? null : createdBy]
          );
          const batchId = b.rows[0].id;
          for (const officer of chunk) {
            const pid = Number(officer.employeeId);
            if (!Number.isSafeInteger(pid)) continue;
            await client.query(
              'INSERT INTO training_batch_members (batch_id, personnel_id, added_by_code) VALUES ($1, $2, TRUE) ON CONFLICT DO NOTHING',
              [batchId, pid]
            );
          }
          batches.push({
            id: batchId,
            batch_no: batchNo,
            mandal,
            group,
            officer_count: chunk.length,
          });
          batchNo += 1;
        }
      }
    }

    await client.query('COMMIT');
    return { batches, errors: [] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { batches, errors: [err.message] };
  } finally {
    client.release();
  }
}

/**
 * Fill a DOCX template from an order record.
 * Two template styles are supported (both fill order-level + batch-level
 * values; nothing is invented):
 *   - {{tags}} templates (preferred): merged via the proven order-merge
 *     engine (docxtemplater + pizzip); missing tags render blank.
 *   - legacy ___ templates (docs/po order.docx, docs/apo order.docx):
 *     sequential ___ runs are replaced in document order with the ordered
 *     fill values (order_id, group, mandal, venue, date/time, counts...).
 * @param {Buffer} templateBytes  the uploaded DOCX
 * @param {Object} order          flat tag->value map (order_id,
 *   trainingGroup, batchNo, mandal, venue, date_time, scheduled_at,
 *   designated_officers, total_officers, prepared_by ...)
 * @returns {Promise<Buffer>} generated DOCX bytes
 */
async function fillDocXPlaceholders(templateBytes, order) {
  const data = order || {};
  // Preferred path: {{tags}}. Only when the template actually contains one
  // (the legacy ___ templates have none — docxtemplater would no-op).
  const probe = Buffer.from(templateBytes).toString('utf8');
  if (probe.includes('{{') || probe.includes('{order_') || probe.includes('{training_')) {
    return mergeDocx(Buffer.from(templateBytes), data);
  }
  // Legacy path: sequential ___ runs -> ordered fill values.
  const PizZipLocal = require('pizzip');
  const ordered = [
    data.order_id, data.trainingGroup, data.mandal, data.venue,
    data.date_time, data.scheduled_at, data.designated_officers,
    data.total_officers, data.batchNo, data.prepared_by,
  ].map((v) => (v == null ? '' : String(v)));
  const zip = new PizZipLocal(Buffer.from(templateBytes));
  const name = 'word/document.xml';
  const file = zip.files[name];
  if (!file) throw new Error('Not a valid DOCX (missing word/document.xml).');
  let xml = file.asText();
  let i = 0;
  xml = xml.replace(/_{2,}/g, (run) => {
    // Keep long decorative rules (e.g. 40+ underscores) untouched; only
    // fill short placeholder runs.
    if (run.length > 20 || i >= ordered.length) return run;
    const val = ordered[i++];
    if (!val) return run;
    return val;
  });
  zip.file(name, xml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Build a training order DOCX from a template + order payload.
 * Returns { buffer: Buffer }.
 */
async function buildTrainingOrderDocx(templateBytes, order) {
  return fillDocXPlaceholders(templateBytes, order);
}

/**
 * Create a training order record + store the generated DOCX bytes.
 */
async function createTrainingOrder(input) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const now = new Date().toISOString();
    const r = await client.query(
      `INSERT INTO training_orders (
         order_id, training_group, batch_id, mandal, venue, date_time,
         scheduled_at, designated_officers, total_officers, status,
         order_pdf, order_docx, created_by, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'generated',$10,$11,$12,$13,$13)
       RETURNING *`,
      [
        input.orderId,
        input.trainingGroup,
        input.batchId,
        input.mandal,
        input.venue,
        input.dateTime,
        input.scheduledAt,
        input.designatedOfficers,
        input.totalOfficers,
        input.orderPdfBuffer,
        input.orderDocxBuffer,
        input.createdBy,
        now,
      ]
    );
    await client.query('COMMIT');
    return { order: r.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List training orders (pagination + filters).
 */
async function listTrainingOrders(params = {}) {
  const { page = 1, perPage = 25, group, status } = params;
  const offset = (page - 1) * perPage;
  const where = [];
  const values = [];
  if (group) {
    where.push(`training_group = $${values.length + 1}`);
    values.push(group);
  }
  if (status) {
    where.push(`status = $${values.length + 1}`);
    values.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countRes = await pool.query(
    `SELECT COUNT(*) FROM training_orders ${whereSql}`,
    values
  );
  const total = Number(countRes.rows[0].count);
  const rows = await pool.query(
    `SELECT id, order_id, training_group, batch_id, mandal, venue, date_time,
            scheduled_at, designated_officers, total_officers, status,
            order_pdf, order_docx, created_by, created_at, updated_at
       FROM training_orders ${whereSql}
       ORDER BY id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, perPage, offset]
  );
  return { orders: rows.rows, page, perPage, total, totalPages: Math.ceil(total / perPage) };
}

/**
 * Download a single order's DOCX (or PDF fallback) as an Attachment.
 */
async function downloadTrainingOrder(id) {
  const r = await pool.query(
    `SELECT order_id, training_group, batch_id, mandal, venue, date_time,
            scheduled_at, designated_officers, total_officers, status,
            order_pdf, order_docx, created_by, created_at, updated_at
       FROM training_orders WHERE id = $1`, [id]
  );
  if (r.rows.length === 0) {
    const err = new Error('Training order not found');
    err.statusCode = 404;
    throw err;
  }
  const order = r.rows[0];
  let buffer = order.order_docx;
  const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (!buffer && order.order_pdf) {
    buffer = order.order_pdf;
    // infer from extension in filename if present
  }
  return { order, buffer, mime };
}

module.exports = {
  parseTrainingData,
  allocateTraining,
  buildTrainingOrderDocx,
  createTrainingOrder,
  listTrainingOrders,
  downloadTrainingOrder,
};
