'use strict';

/**
 * order-assignment.service.js — manual appointments (migration 008).
 *
 * Stage Officer II and counting-team staff are NOT produced by randomization
 * (Stage 1/2/3). An admin picks personnel for these roles by hand; the server
 * only validates and persists — it never invents a person, a role, or a team.
 *
 * Table order_assignments:
 *   id, order_kind, personnel_id, role, team_no, table_no, body_name,
 *   created_by, created_at
 *
 * order_kind allow-list (fixed in code, mirrors the template kinds):
 *   'stage_officer_ii' | 'counting_team'
 * role / team_no / table_no / body_name are authority-supplied free text
 * (the circular's counting-role vocabulary is not yet ratified — Q open),
 * so we validate shape only, never the semantics.
 */

const pool = require('../../database');

const ALLOWED_ORDER_KINDS = ['stage_officer_ii', 'counting_team'];

// Text fields we accept from the client. role is required; the rest optional.
function cleanText(value, { max = 200, required = false, field }) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      const err = new Error(field + ' is required');
      err.statusCode = 400;
      throw err;
    }
    return null;
  }
  if (typeof value !== 'string') {
    const err = new Error(field + ' must be a string');
    err.statusCode = 400;
    throw err;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    const err = new Error(field + ' must be at most ' + max + ' characters');
    err.statusCode = 400;
    throw err;
  }
  return trimmed === '' ? null : trimmed;
}

function parseId(value, field) {
  const n = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(n) || n <= 0) {
    const err = new Error('invalid ' + field);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

/**
 * listAssignments({ orderKind }) — all appointments, newest first, joined to
 * the personnel's non-sensitive identity columns (employee_id/name/designation
 * /work_mandal). Never selects Aadhaar / voter ID / mobile.
 */
async function listAssignments({ orderKind } = {}) {
  const params = [];
  let where = '';
  if (orderKind) {
    if (!ALLOWED_ORDER_KINDS.includes(orderKind)) {
      const err = new Error('unknown order kind');
      err.statusCode = 400;
      throw err;
    }
    where = 'WHERE a.order_kind = $1';
    params.push(orderKind);
  }
  const r = await pool.query(
    `SELECT a.id, a.order_kind, a.personnel_id, a.role, a.team_no, a.table_no,
            a.body_name, a.created_by, a.created_at,
            p.employee_id, p.employee_name, p.designation, p.work_mandal
       FROM order_assignments a
       JOIN personnel p ON p.id = a.personnel_id
       ${where}
      ORDER BY a.order_kind, a.team_no NULLS FIRST, a.table_no NULLS FIRST, a.id`,
    params
  );
  return r.rows;
}

/**
 * createAssignment({ orderKind, personnelId, role, teamNo, tableNo, bodyName,
 *   createdBy }) — validate then insert. Fails closed if the personnel row does
 * not exist. A person may hold only ONE appointment per order_kind (no double
 * booking a Stage Officer II or the same officer twice in counting).
 */
async function createAssignment(input) {
  const orderKind = cleanText(input.orderKind, { max: 40, required: true, field: 'order_kind' });
  if (!ALLOWED_ORDER_KINDS.includes(orderKind)) {
    const err = new Error('order_kind must be one of: ' + ALLOWED_ORDER_KINDS.join(', '));
    err.statusCode = 400;
    throw err;
  }
  const personnelId = parseId(input.personnelId, 'personnelId');
  const role = cleanText(input.role, { max: 120, required: true, field: 'role' });
  const teamNo = cleanText(input.teamNo, { max: 40, field: 'team_no' });
  const tableNo = cleanText(input.tableNo, { max: 40, field: 'table_no' });
  const bodyName = cleanText(input.bodyName, { max: 200, field: 'body_name' });
  const createdBy = input.createdBy == null ? null : parseId(input.createdBy, 'createdBy');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const person = await client.query(
      'SELECT id FROM personnel WHERE id = $1', [personnelId]
    );
    if (person.rows.length === 0) {
      await client.query('ROLLBACK');
      const err = new Error('personnel not found');
      err.statusCode = 404;
      throw err;
    }
    // One appointment per person per order_kind (no double-booking).
    const dup = await client.query(
      'SELECT 1 FROM order_assignments WHERE order_kind = $1 AND personnel_id = $2',
      [orderKind, personnelId]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      const err = new Error('personnel already has a ' + orderKind + ' appointment');
      err.statusCode = 409;
      throw err;
    }
    const ins = await client.query(
      `INSERT INTO order_assignments
         (order_kind, personnel_id, role, team_no, table_no, body_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, order_kind, personnel_id, role, team_no, table_no, body_name,
                 created_by, created_at`,
      [orderKind, personnelId, role, teamNo, tableNo, bodyName, createdBy]
    );
    await client.query('COMMIT');
    return ins.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * updateAssignment({ id, role, teamNo, tableNo, bodyName, personnelId? }) —
 * edit an existing appointment's role/team/table/body (and optionally move it
 * to a different person). role stays required. Unknown id -> 404.
 */
async function updateAssignment(input) {
  const id = parseId(input.id, 'assignment id');
  const role = cleanText(input.role, { max: 120, required: true, field: 'role' });
  const teamNo = cleanText(input.teamNo, { max: 40, field: 'team_no' });
  const tableNo = cleanText(input.tableNo, { max: 40, field: 'table_no' });
  const bodyName = cleanText(input.bodyName, { max: 200, field: 'body_name' });
  const moveTo = input.personnelId === undefined || input.personnelId === null
    ? null : parseId(input.personnelId, 'personnelId');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, order_kind, personnel_id FROM order_assignments WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      const err = new Error('assignment not found');
      err.statusCode = 404;
      throw err;
    }
    const row = existing.rows[0];
    const targetPersonnel = moveTo == null ? row.personnel_id : moveTo;
    if (moveTo != null) {
      const person = await client.query('SELECT id FROM personnel WHERE id = $1', [moveTo]);
      if (person.rows.length === 0) {
        await client.query('ROLLBACK');
        const err = new Error('personnel not found');
        err.statusCode = 404;
        throw err;
      }
      const dup = await client.query(
        'SELECT 1 FROM order_assignments WHERE order_kind = $1 AND personnel_id = $2 AND id <> $3',
        [row.order_kind, moveTo, id]
      );
      if (dup.rows.length > 0) {
        await client.query('ROLLBACK');
        const err = new Error('personnel already has a ' + row.order_kind + ' appointment');
        err.statusCode = 409;
        throw err;
      }
    }
    const upd = await client.query(
      `UPDATE order_assignments
          SET role = $1, team_no = $2, table_no = $3, body_name = $4, personnel_id = $5
        WHERE id = $6
        RETURNING id, order_kind, personnel_id, role, team_no, table_no, body_name,
                  created_by, created_at`,
      [role, teamNo, tableNo, bodyName, targetPersonnel, id]
    );
    await client.query('COMMIT');
    return upd.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** deleteAssignment({ id }) — remove one appointment. Unknown id -> 404. */
async function deleteAssignment({ id }) {
  const numId = parseId(id, 'assignment id');
  const r = await pool.query(
    'DELETE FROM order_assignments WHERE id = $1 RETURNING id',
    [numId]
  );
  if (r.rows.length === 0) {
    const err = new Error('assignment not found');
    err.statusCode = 404;
    throw err;
  }
  return { id: r.rows[0].id, deleted: true };
}

module.exports = {
  ALLOWED_ORDER_KINDS,
  listAssignments,
  createAssignment,
  updateAssignment,
  deleteAssignment,
};
