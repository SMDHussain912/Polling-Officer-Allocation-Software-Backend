'use strict';

/**
 * Training routes (protected, in-memory service).
 *
 *   GET  /api/training/sessions              list (any authenticated user)
 *   POST /api/training/sessions              create (authority/admin)
 *   GET  /api/training/sessions/:id/attendance   view (any authenticated user)
 *   POST /api/training/sessions/:id/attendance   mark (authority/admin)
 *
 * Sessions/attendance are authority-supplied; no schedules, venues or
 * completion statuses are invented by the server.
 */

const express = require('express');
const { requireAuth, authorize } = require('../../middleware/auth');
const { createTrainingService } = require('./service');
const pool = require('../../database');

const router = express.Router();
router.use(requireAuth);
const service = createTrainingService();

router.get('/sessions', (req, res) => {
  res.json({ ok: true, sessions: service.listSessions() });
});

/**
 * training_batches / training_batch_members (new model).
 * Code-assigned per-mandal batches (<=100 officers each, random within the
 * mandal, no cross-mandal mixing). Admin can read location + members.
 * (Editing/assigning happens via separate PATCH endpoints later.)
 */
router.get('/batches', async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT b.id, b.batch_no, b.mandal, b.location_id, b.created_at,
              l.location_name,
              (SELECT count(*) FROM training_batch_members WHERE batch_id = b.id) AS member_count
         FROM training_batches b
         LEFT JOIN training_locations l ON l.id = b.location_id
        ORDER BY b.mandal, b.batch_no`
    );
    res.json({ ok: true, batches: rows.rows });
  } catch (err) {
    console.error('list training batches failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load training batches' });
  }
});

router.get('/batches/:id/members', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid batch id' });
  }
  try {
    const batch = await pool.query(
      `SELECT id, batch_no, mandal, location_id, created_at
         FROM training_batches WHERE id = $1`, [id]
    );
    if (batch.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Batch not found' });
    }
    const members = await pool.query(
      `SELECT p.id AS personnel_id, p.employee_id, p.employee_name,
              p.designation, p.native_mandal, p.work_mandal
         FROM personnel p
         JOIN training_batch_members m ON m.personnel_id = p.id
        WHERE m.batch_id = $1
        ORDER BY p.employee_name`, [id]
    );
    res.json({ ok: true, batch: batch.rows[0], members: members.rows });
  } catch (err) {
    console.error('load batch members failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load batch members' });
  }
});

// Candidate training locations for a batch (same mandal only — batches never
// mix mandals, Q1). Used by the admin location dropdown.
router.get('/batches/:id/locations', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid batch id' });
  }
  try {
    const batch = await pool.query(
      'SELECT id, mandal FROM training_batches WHERE id = $1', [id]
    );
    if (batch.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Batch not found' });
    }
    const mandal = batch.rows[0].mandal;
    const locs = await pool.query(
      `SELECT id, location_name, panchayat, mandal, category
         FROM training_locations
        WHERE mandal = $1
        ORDER BY location_name`, [mandal]
    );
    res.json({ ok: true, mandal, locations: locs.rows });
  } catch (err) {
    console.error('list batch locations failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to load locations' });
  }
});

// Admin assigns (or clears) the training location for a batch. Location must
// belong to the batch's mandal. Body: { locationId: number | null }.
router.patch(
  '/batches/:id/location',
  authorize('authority', 'admin'),
  async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid batch id' });
    }
    const raw = req.body ? req.body.locationId : undefined;
    const locationId = raw === null || raw === undefined || raw === '' ? null : Number.parseInt(raw, 10);
    if (locationId !== null && (!Number.isSafeInteger(locationId) || locationId <= 0)) {
      return res.status(400).json({ ok: false, error: 'Invalid location id' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await client.query(
        'SELECT id, mandal FROM training_batches WHERE id = $1 FOR UPDATE', [id]
      );
      if (batch.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'Batch not found' });
      }
      const mandal = batch.rows[0].mandal;
      if (locationId !== null) {
        const loc = await client.query(
          'SELECT id, mandal FROM training_locations WHERE id = $1', [locationId]
        );
        if (loc.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ ok: false, error: 'Location not found' });
        }
        if (loc.rows[0].mandal !== mandal) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            ok: false,
            error: `Location must be in the batch mandal (${mandal})`,
          });
        }
      }
      await client.query(
        'UPDATE training_batches SET location_id = $1 WHERE id = $2',
        [locationId, id]
      );
      await client.query('COMMIT');
      res.json({ ok: true, id, locationId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('assign batch location failed:', err);
      res.status(500).json({ ok: false, error: 'Failed to assign location' });
    } finally {
      client.release();
    }
  }
);

router.post('/sessions', authorize('authority', 'admin'), (req, res) => {
  try {
    const session = service.createSession(req.body || {}, req.session.user.id);
    res.status(201).json({ ok: true, session: session });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('training create failed:', err);
    res.status(status).json({ ok: false, error: err.message });
  }
});

router.get('/sessions/:id/attendance', (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid session id' });
    }
    res.json({ ok: true, attendance: service.sessionAttendance(id) });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('training attendance read failed:', err);
    res.status(status).json({ ok: false, error: err.message });
  }
});

router.post('/sessions/:id/attendance', authorize('authority', 'admin'), (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid session id' });
    }
    const written = service.markAttendance(id, (req.body || {}).records);
    res.json({ ok: true, attendance: written });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('training attendance write failed:', err);
    res.status(status).json({ ok: false, error: err.message });
  }
});

router.delete(
  '/batches/:id/members/:personnelId',
  async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const personnelId = Number.parseInt(req.params.personnelId, 10);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(personnelId) || personnelId <= 0) {
      return res.status(400).json({ ok: false, error: 'Invalid batch or personnel id' });
    }
    try {
      await pool.query(
        `DELETE FROM training_batch_members
           WHERE batch_id = $1 AND personnel_id = $2`,
        [id, personnelId]
      );
      res.json({ ok: true, deleted: true });
    } catch (err) {
      console.error('remove batch member failed:', err);
      res.status(500).json({ ok: false, error: 'Failed to remove member from batch' });
    }
  }
);

module.exports = router;
// Separate PO/APO training orders (designation-based).
// NOTE: the two routes below are DISABLED — they queried tables that were
// never created (designation_rules, stage3_assignments with a personnel_id
// column) and returned 500 for every request. PO/APO orders are served by
// the training-orders module (migration 013 tables + built-in DOCX
// templates); see TRAINING-ORDERS-ANALYSIS.md. Kept as 410 Gone with a
// pointer so old frontend builds fail loudly instead of silently.
// PO/APO training orders live in the training-orders module (migration 013
// tables + built-in DOCX templates); see TRAINING-ORDERS-ANALYSIS.md.
// The two legacy routes below are disabled: they queried tables that were
// never created (designation_rules, stage3_assignments with a personnel_id
// column) and returned 500 for every request. They now answer 410 Gone so
// old callers fail loudly instead of silently.
router.get('/batches/:id/orders', (req, res) => {
  res.status(410).json({
    ok: false,
    error: 'Gone: replaced by GET /api/imports/training-orders?group=PO|APO (migration 013 tables).',
  });
});

router.post('/batches/:id/orders', (req, res) => {
  res.status(410).json({
    ok: false,
    error: 'Gone: replaced by POST /api/imports/training-orders/generate { group }.',
  });
});


