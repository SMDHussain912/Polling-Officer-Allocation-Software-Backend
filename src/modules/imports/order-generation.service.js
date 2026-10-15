'use strict';

/**
 * order-generation.service.js — generate an order .docx for an appointment and
 * (optionally) email it as an attachment.
 *
 * Flow for generateAndSend({ assignmentId, sendEmail, actorId }):
 *   1. load the manual appointment + its personnel (non-sensitive columns)
 *   2. load the active template for the appointment's order_kind
 *   3. load order_config (election metadata)
 *   4. build the merge data + merge the .docx (order-merge.service)
 *   5. record metadata in generated_documents (the .docx bytes are NOT stored
 *      in the DB — scope_id points at the assignment; file on disk optional)
 *   6. if sendEmail and the personnel has an email -> send via the Gmail
 *      provider with the .docx attached (fails clearly if unconfigured)
 *
 * Nothing is invented: if there is no template, no email, or the provider is
 * unconfigured, we fail closed with a clear reason (never a fake success).
 */

const pool = require('../../database');
const { getOrderTemplate, getOrderConfig } = require('./intake.service');
const { mergeDocx, buildMergeData, filenameFor } = require('./order-merge.service');
const { createGmailProvider } = require('../notifications/providers');

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
              p.native_mandal, p.email
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
 * generateAndSend({ assignmentId, sendEmail, actorId }):
 *   generates the .docx, records generated_documents metadata, and when
 *   sendEmail is true emails it to the officer. Returns a summary.
 */
async function generateAndSend({ assignmentId, sendEmail, actorId } = {}) {
  const { fileName, buffer, assignment, templateKind } = await generateOrderDocx(assignmentId);

  const doc = await recordGeneratedDocument({
    kind: 'order_docx',
    templateKind,
    scopeType: 'assignment',
    scopeId: assignment.id,
    fileName,
    createdBy: actorId,
  });

  const result = {
    ok: true,
    document: doc,
    fileName,
    bytes: buffer.length,
    emailed: false,
  };

  if (sendEmail) {
    if (!assignment.email) {
      // No address on file -> we did NOT send; surface it, never fake success.
      result.emailError = 'personnel has no email on file';
      return result;
    }
    const gmail = createGmailProvider();
    if (!gmail.isConfigured()) {
      result.emailError = 'email provider not configured (GMAIL_* env missing)';
      return result;
    }
    const subject = (assignment.role || 'Polling Duty') + ' — appointment order';
    const message =
      'Dear ' + (assignment.employee_name || 'Officer') + ',\n\n' +
      'Please find attached your appointment order (' + (assignment.role || '') + ').\n';
    const sent = await gmail.send({
      to: assignment.email,
      subject,
      message,
      attachments: [
        {
          filename: fileName,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          content: buffer.toString('base64'),
        },
      ],
    });
    result.emailed = true;
    result.providerMessageId = sent.providerMessageId || null;
    result.email = assignment.email;
  }

  return result;
}

module.exports = {
  KIND_TO_TEMPLATE,
  generateOrderDocx,
  generateAndSend,
};
