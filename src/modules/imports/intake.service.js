'use strict';

/**
 * Stage: imports — Phase-1 intake persistence.
 *
 * Upload semantics (documented so admin can trust re-upload):
 *   - Each intake upload REPLACES the whole target table in ONE transaction
 *     (that is how a corrected file supersedes the old one). Manual edits
 *     happen AFTER upload via the PATCH endpoints; a later re-upload
 *     overwrites them (re-edit after).
 *   - Rejected rows are NOT stored (intake tables are clean lists); they are
 *     returned to the caller with reasons so the admin fixes the file.
 *     (Different from personnel: officer rejected rows ARE stored per
 *     team decision 2026-10-14.)
 *
 * Training batches are created by CODE here: random within each mandal,
 * <=100 per batch (team decision Q1/Q3). Creation refuses to run while
 * batches already exist (edits must be preserved); clear first to re-run.
 */

const crypto = require('crypto');
const pool = require('../../database');

const MAX_BATCH_SIZE = 100;

async function replaceMicroObservers({ buffer }) {
  const { parseMicroObservers } = require('./intake');
  const { accepted, rejected } = parseMicroObservers(buffer);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM micro_observers');
    for (const r of accepted) {
      await client.query(
        `INSERT INTO micro_observers
           (sl_no, employee_id, employee_name, designation, bank_name, gender,
            mobile_no, native_mandal, residence_mandal, working_mandal, alloted_mandal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [r.sl_no, r.employee_id, r.employee_name, r.designation, r.bank_name,
         r.gender, r.mobile_no, r.native_mandal, r.residence_mandal,
         r.working_mandal, r.alloted_mandal]
      );
    }
    await client.query('COMMIT');
    return { totalRows: accepted.length + rejected.length, acceptedRows: accepted.length, rejectedRows: rejected.length, rejected };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function replaceTrainingLocations({ buffer }) {
  const { parseTrainingLocations } = require('./intake');
  const { accepted, rejected } = parseTrainingLocations(buffer);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const linked = await client.query(
      'SELECT DISTINCT location_id FROM training_batches WHERE location_id IS NOT NULL'
    );
    if (linked.rows.length > 0) {
      const err = new Error('training batches already reference locations; clear batches before re-uploading locations');
      err.statusCode = 409;
      throw err;
    }
    await client.query('DELETE FROM training_locations');
    for (const r of accepted) {
      await client.query(
        `INSERT INTO training_locations (location_name, panchayat, mandal, category)
         VALUES ($1,$2,$3,$4)`,
        [r.location_name, r.panchayat, r.mandal, r.category]
      );
    }
    await client.query('COMMIT');
    return { totalRows: accepted.length + rejected.length, acceptedRows: accepted.length, rejectedRows: rejected.length, rejected };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function replaceRequirements({ buffer }) {
  const { parseRequirements } = require('./intake');
  const { accepted, rejected } = parseRequirements(buffer);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM election_requirements');
    for (const r of accepted) {
      await client.query(
        `INSERT INTO election_requirements
           (phase, division_name, mandal, no_of_gps, sensitive_loc,
            hyper_sensitive_loc, required_count, reserve_count, total_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.phase, r.division_name, r.mandal, r.no_of_gps, r.sensitive_loc,
         r.hyper_sensitive_loc, r.required_count, r.reserve_count, r.total_count]
      );
    }
    await client.query('COMMIT');
    return { totalRows: accepted.length + rejected.length, acceptedRows: accepted.length, rejectedRows: rejected.length, rejected };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * createTrainingBatches() — code-created batches.
 * Random (Fisher-Yates with crypto RNG) WITHIN each mandal, chunk <= 100.
 * Officers = active district personnel NOT exempt/pending (training is for
 * those who will serve; MOs live in their own table and are not included).
 * Refuses while batches exist (manual edits preserved); clear first to re-run.
 */
async function createTrainingBatches({ createdBy }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT count(*) FROM training_batches');
    if (Number(existing.rows[0].count) > 0) {
      const err = new Error('training batches already exist; clear them first to re-create');
      err.statusCode = 409;
      throw err;
    }
    const officers = await client.query(
      `SELECT id, work_mandal FROM personnel
        WHERE is_active = TRUE
          AND district = 'Kakinada'
          AND (exempt_category IS NULL OR exempt_category = '')
        ORDER BY id`
    );
    if (officers.rows.length === 0) {
      const err = new Error('no eligible officers found (import personnel first)');
      err.statusCode = 409;
      throw err;
    }
    const byMandal = new Map();
    for (const o of officers.rows) {
      const mandal = (o.work_mandal || 'UNSPECIFIED').trim() || 'UNSPECIFIED';
      if (!byMandal.has(mandal)) byMandal.set(mandal, []);
      byMandal.get(mandal).push(o.id);
    }
    let created = 0;
    for (const [mandal, ids] of byMandal) {
      for (let i = ids.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(i + 1);
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      let batchNo = 1;
      for (let start = 0; start < ids.length; start += MAX_BATCH_SIZE) {
        const chunk = ids.slice(start, start + MAX_BATCH_SIZE);
        const b = await client.query(
          `INSERT INTO training_batches (batch_no, mandal, created_by)
           VALUES ($1,$2,$3) RETURNING id`,
          [batchNo, mandal, createdBy ?? null]
        );
        const batchId = b.rows[0].id;
        for (const pid of chunk) {
          await client.query(
            `INSERT INTO training_batch_members (batch_id, personnel_id, added_by_code)
             VALUES ($1,$2,TRUE)`,
            [batchId, pid]
          );
        }
        created += 1;
        batchNo += 1;
      }
    }
    await client.query('COMMIT');
    return { batches: created, officers: officers.rows.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * clearTrainingBatches() — wipe batches + members so create can re-run.
 * Does NOT touch officers, locations, or anything else.
 */
async function clearTrainingBatches() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM training_batch_members');
    await client.query('DELETE FROM training_batches');
    await client.query('COMMIT');
    return { cleared: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


/**
 * Order templates / order config / idcard design persistence.
 * Kept here so intake.service.js can export them alongside intake functions.
 * (Moved to separate template.service.js in a future refactor if desired.)
 */

const pool2 = require('../../database');
const ALLOWED_KINDS = [
  'polling_team',
  'stage_officer_ii',
  'counting_team',
  'po_apo_training',
  'po_apo_training_gp',
  'id_card',
];

async function upsertOrderTemplate({ kind, display_name, file_name, file, uploadedBy }) {
  if (!ALLOWED_KINDS.includes(kind)) {
    const err = new Error('unknown template kind: ' + kind);
    err.statusCode = 400;
    throw err;
  }
  const client = await pool2.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO order_templates (kind, display_name, file_name, file, uploaded_by, active, updated_at)
       VALUES ($1,$2,$3,$4,$5,TRUE, now())
       ON CONFLICT (kind) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             file_name = EXCLUDED.file_name,
             file = EXCLUDED.file,
             uploaded_by = EXCLUDED.uploaded_by,
             active = TRUE,
             updated_at = now()`,
      [kind, display_name, file_name, file, uploadedBy]
    );
    await client.query(
      `UPDATE order_templates SET active = FALSE, updated_at = now()
       WHERE kind = $1 AND id <> (SELECT id FROM order_templates WHERE kind = $1 AND active LIMIT 1)`,
      [kind]
    );
    await client.query('COMMIT');
    return { kind, display_name, file_name };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getOrderTemplates({ kind } = {}) {
  const client = await pool2.connect();
  try {
    await client.query('BEGIN');
    let rows = [];
    if (kind) {
      const r = await client.query(
        'SELECT id, kind, display_name, file_name, active, updated_at FROM order_templates WHERE kind = $1 ORDER BY id',
        [kind]
      );
      rows = r.rows;
    } else {
      const r = await client.query(
        'SELECT id, kind, display_name, file_name, active, updated_at FROM order_templates ORDER BY kind, id'
      );
      rows = r.rows;
    }
    await client.query('COMMIT');
    return { templates: rows };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getOrderTemplate(kind) {
  const client = await pool2.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, kind, display_name, file_name, file, uploaded_by, updated_at
         FROM order_templates
        WHERE kind = $1 AND active
        ORDER BY id
        LIMIT 1`,
      [kind]
    );
    await client.query('COMMIT');
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      kind: row.kind,
      display_name: row.display_name,
      file_name: row.file_name,
      buffer: row.file,
      uploadedBy: row.uploaded_by,
      uploadedAt: row.updated_at,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getOrderConfig() {
  const client = await pool2.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, election_title, district, order_date, order_place,
              distribution_center, distribution_report_time, polling_date_time,
              training_venue, training_date_time, warning_text, extra_note,
              updated_by, updated_at
         FROM order_config WHERE id = 1`
    );
    await client.query('COMMIT');
    if (r.rows.length === 0) return { config: {} };
    return { config: r.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function upsertOrderConfig({ config, updatedBy }) {
  const client = await pool2.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO order_config (id, election_title, district, order_date, order_place,
          distribution_center, distribution_report_time, polling_date_time,
          training_venue, training_date_time, warning_text, extra_note,
          updated_by, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       ON CONFLICT (id) DO UPDATE
         SET election_title = EXCLUDED.election_title,
             district = EXCLUDED.district,
             order_date = EXCLUDED.order_date,
             order_place = EXCLUDED.order_place,
             distribution_center = EXCLUDED.distribution_center,
             distribution_report_time = EXCLUDED.distribution_report_time,
             polling_date_time = EXCLUDED.polling_date_time,
             training_venue = EXCLUDED.training_venue,
             training_date_time = EXCLUDED.training_date_time,
             warning_text = EXCLUDED.warning_text,
             extra_note = EXCLUDED.extra_note,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [
        config.election_title || '',
        config.district || '',
        config.order_date || '',
        config.order_place || '',
        config.distribution_center || '',
        config.distribution_report_time || '',
        config.polling_date_time || '',
        config.training_venue || '',
        config.training_date_time || '',
        config.warning_text || '',
        config.extra_note || '',
        updatedBy,
      ]
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function upsertIdCardDesign({ design, updatedBy }) {
  const client = await pool2.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO id_card_design (id, design, updated_by, updated_at)
       VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE
         SET design = EXCLUDED.design,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [JSON.stringify(design), updatedBy]
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get id_card_design JSONB payload (GET /idcard-design). Placeholder route in
 * index.js returns {}; this returns the real stored payload.
 */
async function getIdCardDesign() {
  const client = await pool2.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT design, updated_by, updated_at FROM id_card_design WHERE id = 1`
    );
    await client.query('COMMIT');
    if (r.rows.length === 0) return { design: {} };
    return { design: r.rows[0].design };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function replaceMandalAdjacency({ buffer }) {
  const { parseMandalAdjacency } = require('./intake');
  const { accepted, rejected } = parseMandalAdjacency(buffer);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM mandal_adjacency');
    for (const r of accepted) {
      await client.query(
        `INSERT INTO mandal_adjacency (mandal_name, near_mandal_names, updated_at)
         VALUES ($1, $2::text[], now())`,
        [r.mandal_name, r.near_mandal_names]
      );
    }
    await client.query('COMMIT');
    return { totalRows: accepted.length + rejected.length, acceptedRows: accepted.length, rejectedRows: rejected.length, rejected };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function replaceTrainingSessions({ buffer, createdBy }) {
  const { parseTrainingSessions } = require('./intake');
  const { accepted, rejected } = parseTrainingSessions(buffer);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM training_sessions');
    for (const r of accepted) {
      await client.query(
        `INSERT INTO training_sessions
           (district, title, session_type, mandal, venue, scheduled_at,
            duration_minutes, conducted_by, created_by_user_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.district, r.title, r.session_type, r.mandal, r.venue, r.scheduled_at,
         r.duration_minutes, r.conducted_by, createdBy, r.status]
      );
    }
    await client.query('COMMIT');
    return { totalRows: accepted.length + rejected.length, acceptedRows: accepted.length, rejectedRows: rejected.length, rejected };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


module.exports = {
  replaceMicroObservers,
  replaceTrainingLocations,
  replaceTrainingSessions,
  replaceMandalAdjacency,
  replaceRequirements,
  createTrainingBatches,
  clearTrainingBatches,
  MAX_BATCH_SIZE: 100,
  upsertOrderTemplate,
  getOrderTemplates,
  getOrderTemplate,
  getOrderConfig,
  upsertOrderConfig,
  upsertIdCardDesign,
  getIdCardDesign,
  ALLOWED_KINDS,
};
