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
    // Batches reference locations by id — re-upload must not orphan them.
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
        [r.location_name, r.mandal, r.panchayat, r.category]
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
      // Fisher-Yates with crypto.randomInt (no modulo bias).
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

module.exports = {
  replaceMicroObservers,
  replaceTrainingLocations,
  replaceRequirements,
  createTrainingBatches,
  clearTrainingBatches,
  MAX_BATCH_SIZE: 100,
};