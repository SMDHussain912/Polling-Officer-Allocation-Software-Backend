'use strict';

/**
 * order-generation.service.js — generate an order .docx for an appointment.
 *
 * Flow for generateOrder({ assignmentId, actorId }):
 *   1. load the manual appointment + its personnel (non-sensitive columns)
 *   2. load the active template for the appointment's order_kind
 *   3. load order_config (election metadata)
 *   4. build the merge data + merge the .docx (order-merge.service)
 *   5. record metadata in generated_documents (the .docx bytes are NOT stored
 *      in the DB — scope_id points at the assignment; file on disk optional)
 *
 * Nothing is invented: if there is no template we fail closed with a clear
 * reason (never a fake success). Delivery is out of scope — the caller
 * downloads the .docx from the generate response.
 */

const pool = require('../../database');
const { getOrderTemplate, getOrderConfig } = require('./intake.service');
const { mergeDocx, buildMergeData, filenameFor } = require('./order-merge.service');

// order_kind -> template kind. Manual appointments map 1:1 to a template kind.
const KIND_TO_TEMPLATE = {
  stage_officer_ii: 'stage_officer_ii',
  counting_team: 'counting_team',
};

function loadAssignmentWithPersonnel(assignmentId) {
  return pool
    .query(
      `SELECT a.id, a.order_kind, a.personnel_id, a.role, a.team_no, a.table_no,
              a.body_name,
              p.employee_id, p.employee_name, p.designation, p.work_mandal,
              p.native_mandal
         FROM order_assignments a
         JOIN personnel p ON p.id = a.personnel_id
        WHERE a.id = $1`,
      [assignmentId]
    )
    .then((r) => r.rows[0] || null);
}

function recordGeneratedDocument({ kind, templateKind, scopeType, scopeId, fileName, createdBy }) {
  // file_path is a logical reference (assignment-scoped); the bytes themselves
  // are attached to the email, not persisted to disk by this service.
  const filePath = 'generated/' + scopeType + '/' + scopeId + '/' + fileName;
  return pool
    .query(
      `INSERT INTO generated_documents
         (kind, template_kind, scope_type, scope_id, file_name, file_path, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, kind, template_kind, scope_type, scope_id, file_name, file_path, created_at`,
      [kind, templateKind, scopeType, String(scopeId), fileName, filePath, createdBy == null ? null : createdBy]
    )
    .then((r) => r.rows[0]);
}

/**
 * generateOrderDocx(assignmentId) -> { fileName, buffer, assignment, doc }
 * Pure generation (no email, no DB write to generated_documents).
 */
async function generateOrderDocx(assignmentId) {
  const id = Number.parseInt(assignmentId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const err = new Error('invalid assignment id');
    err.statusCode = 400;
    throw err;
  }
  const assignment = await loadAssignmentWithPersonnel(id);
  if (!assignment) {
    const err = new Error('assignment not found');
    err.statusCode = 404;
    throw err;
  }
  const templateKind = KIND_TO_TEMPLATE[assignment.order_kind];
  if (!templateKind) {
    const err = new Error('no template mapping for order kind ' + assignment.order_kind);
    err.statusCode = 400;
    throw err;
  }
  const template = await getOrderTemplate(templateKind);
  if (!template) {
    const err = new Error('no active template uploaded for kind ' + templateKind);
    err.statusCode = 409;
    throw err;
  }
  const { config } = await getOrderConfig();
  const personnel = {
    employee_id: assignment.employee_id,
    employee_name: assignment.employee_name,
    designation: assignment.designation,
    work_mandal: assignment.work_mandal,
    native_mandal: assignment.native_mandal,
  };
  const appointment = {
    role: assignment.role,
    team_no: assignment.team_no,
    table_no: assignment.table_no,
    body_name: assignment.body_name,
  };
  const data = buildMergeData({ orderConfig: config, personnel, assignment: appointment });
  const buffer = mergeDocx(template.buffer, data);
  const fileName = filenameFor({ kind: templateKind, personnel, assignment: appointment });
  return { fileName, buffer, assignment, templateKind };
}

/**
 * generateOrder({ assignmentId, actorId }):
 *   generates the .docx and records generated_documents metadata.
 *   Returns { ok, document, fileName, bytes, docxBase64 }.
 */
async function generateOrder({ assignmentId, actorId } = {}) {
  const { fileName, buffer, assignment, templateKind } = await generateOrderDocx(assignmentId);

  const doc = await recordGeneratedDocument({
    kind: 'order_docx',
    templateKind,
    scopeType: 'assignment',
    scopeId: assignment.id,
    fileName,
    createdBy: actorId,
  });

  return {
    ok: true,
    document: doc,
    fileName,
    bytes: buffer.length,
    // base64 so the client can download/save without a disk round-trip.
    docxBase64: buffer.toString('base64'),
  };
}

module.exports = {
  KIND_TO_TEMPLATE,
  generateOrderDocx,
  generateOrder,
};
