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

const router = express.Router();
router.use(requireAuth);
const service = createTrainingService();

router.get('/sessions', (req, res) => {
  res.json({ ok: true, sessions: service.listSessions() });
});

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

module.exports = router;

