'use strict';

/**
 * order-merge.service.js — generate .docx orders from templates + merge data.
 *
 * Loads the active order template (migration 008 order_templates, real .docx
 * bytes), fills it with docxtemplater from a data object, and returns the
 * merged .docx buffer. NO placeholders are invented here: the template author
 * decides the {{tags}}; the caller (route) supplies the data object. Missing
 * data -> docxtemplater null-getter leaves the tag blank (never throws, never
 * fabricates a value).
 *
 * Also assembles the standard merge data from order_config + a personnel /
 * appointment record so the common fields are consistent across orders.
 */

const Docxtemplater = require('docxtemplater');
const PizZip = require('pizzip');

/**
 * mergeDocx(templateBuffer, data) -> Buffer (filled .docx).
 * Throws on a malformed template (fail closed — never return a broken file).
 */
function mergeDocx(templateBuffer, data) {
  if (!templateBuffer || templateBuffer.length === 0) {
    const err = new Error('template buffer is empty');
    err.statusCode = 400;
    throw err;
  }
  let zip;
  try {
    zip = new PizZip(templateBuffer);
  } catch (e) {
    const err = new Error('template is not a valid .docx (zip) file');
    err.statusCode = 400;
    throw err;
  }
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    // Missing keys render as empty string instead of throwing; we never
    // invent values, and a blank tag is safer than a failed render.
    nullGetter: () => '',
  });
  try {
    doc.render(data || {});
  } catch (e) {
    const err = new Error('docx merge failed: ' + (e && e.message ? e.message : 'render error'));
    err.statusCode = 422;
    throw err;
  }
  const out = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  return out;
}

/**
 * buildMergeData({ orderConfig, personnel, assignment, extra }) -> object.
 * Flattens the pieces the templates commonly reference into one flat map of
 * {{tags}}. Only fields that exist are included; nothing is fabricated.
 *   orderConfig: the single order_config row (election_title, dates, ...)
 *   personnel:   { employee_id, employee_name, designation, work_mandal, ... }
 *   assignment:  { role, team_no, table_no, body_name } (manual appointment)
 *   extra:       any additional tag->value map the caller wants to merge
 */
function buildMergeData({ orderConfig, personnel, assignment, extra } = {}) {
  const cfg = orderConfig || {};
  const per = personnel || {};
  const asg = assignment || {};
  const data = {
    // election / order metadata (from order_config)
    election_title: cfg.election_title || '',
    district: cfg.district || '',
    order_date: cfg.order_date || '',
    order_place: cfg.order_place || '',
    distribution_center: cfg.distribution_center || '',
    distribution_report_time: cfg.distribution_report_time || '',
    polling_date_time: cfg.polling_date_time || '',
    training_venue: cfg.training_venue || '',
    training_date_time: cfg.training_date_time || '',
    warning_text: cfg.warning_text || '',
    extra_note: cfg.extra_note || '',
    // personnel identity (non-sensitive only)
    employee_id: per.employee_id || '',
    employee_name: per.employee_name || '',
    name: per.employee_name || '',
    designation: per.designation || '',
    work_mandal: per.work_mandal || '',
    native_mandal: per.native_mandal || '',
    // appointment / duty specifics
    role: asg.role || '',
    team_no: asg.team_no || '',
    table_no: asg.table_no || '',
    body_name: asg.body_name || '',
  };
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) data[k] = extra[k] == null ? '' : extra[k];
  }
  return data;
}

/**
 * filenameFor({ kind, personnel, assignment }) -> string.
 * Deterministic, filesystem/email-safe order file name.
 */
function filenameFor({ kind, personnel, assignment } = {}) {
  const per = personnel || {};
  const asg = assignment || {};
  const who = (per.employee_id || per.employee_name || 'officer')
    .toString().replace(/[^a-zA-Z0-9._-]+/g, '_');
  const suffix = asg.role ? '_' + asg.role.toString().replace(/[^a-zA-Z0-9._-]+/g, '_') : '';
  return (kind || 'order') + '_' + who + suffix + '.docx';
}

module.exports = {
  mergeDocx,
  buildMergeData,
  filenameFor,
};
