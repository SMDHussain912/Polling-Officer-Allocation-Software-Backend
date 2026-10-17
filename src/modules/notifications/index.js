'use strict';

/**
 * Notification routes (protected). Session auth + role gate on every endpoint.
 *
 *   GET  /api/notifications/channels     channel configuration status
 *   POST /api/notifications/preview      render per-recipient messages (no send)
 *   POST /api/notifications/send         authorised dispatch (authority/admin)
 *   GET  /api/notifications/deliveries   delivery-attempt report
 *
 * Send requires an explicit `confirmAllocation: true` in the body so an
 * authorised officer must actively confirm the final allocation before any
 * message leaves the system. Unconfigured providers are reported, never faked.
 */

const express = require('express');
const { requireAuth, authorize } = require('../../middleware/auth');
const { createFast2smsProvider, createWhatsAppProvider } = require('./providers');
const { createNotificationService } = require('./service');
const pool = require('../../database');

const router = express.Router();
router.use(requireAuth);

const service = createNotificationService({
  providers: [createFast2smsProvider(), createWhatsAppProvider()],
});

// Channel configuration status — any authenticated user (read-only).
router.get('/channels', (req, res) => {
  res.json({ ok: true, channels: service.channelStatus() });
});

// Preview — authority/admin; renders messages without contacting providers.
router.post('/preview', authorize('authority', 'admin'), (req, res) => {
  try {
    const result = service.preview(req.body || {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Send — authority/admin AND explicit allocation confirmation.
router.post('/send', authorize('authority', 'admin'), async (req, res) => {
  const body = req.body || {};
  if (body.confirmAllocation !== true) {
    return res.status(400).json({
      ok: false,
      error: 'confirmAllocation must be true — an authorised officer must confirm the final allocation before sending.',
    });
  }
  try {
    const result = await service.send(body);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /send-team — Stage-3 duty notification for ONE team of the latest run.
 * Body: { teamCode, confirmAllocation: true, election?, config? }
 *
 * The server loads the team, its members (mobiles included) and the Stage-3
 * station from the frozen roster (migration 016) so contact numbers never
 * cross the wire. Dispatches through the same service.send() path (SMS +
 * WhatsApp channels; email channel was removed with the mail system).
 * Fails closed: unknown teamCode -> 404, missing roster run -> 409.
 */
router.post('/send-team', authorize('authority', 'admin'), async (req, res) => {
  const body = req.body || {};
  if (body.confirmAllocation !== true) {
    return res.status(400).json({
      ok: false,
      error: 'confirmAllocation must be true — an authorised officer must confirm the final allocation before sending.',
    });
  }
  const teamCode = String(body.teamCode || '').trim();
  if (!teamCode) {
    return res.status(400).json({ ok: false, error: 'teamCode is required' });
  }
  try {
    const roster = await pool.query(
      `SELECT run_id, team_code, posting_mandal, team_size, operational_size,
              station_id, station_code, station_mandal
         FROM team_rosters
        WHERE run_id = (SELECT MAX(run_id) FROM team_rosters)
          AND team_code = $1`,
      [teamCode]
    );
    if (roster.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Team ' + teamCode + ' not found in the latest run' });
    }
    const t = roster.rows[0];
    const mem = await pool.query(
      `SELECT employee_id, name, role, mobile_no, is_micro_observer
         FROM team_roster_members
        WHERE run_id = $1 AND team_code = $2
        ORDER BY role`,
      [t.run_id, t.team_code]
    );
    if (mem.rows.length === 0) {
      return res.status(409).json({ ok: false, error: 'Team ' + teamCode + ' has no members on the roster' });
    }
    const recipients = mem.rows.map(function (m) {
      return {
        personnelId: m.employee_id,
        name: m.name || m.employee_id,
        role: m.role,
        isMicroObserver: !!m.is_micro_observer,
        mobile: m.mobile_no || null,
      };
    });
    const result = await service.send({
      recipients: recipients,
      party: {
        teamCode: t.team_code,
        teamSize: t.team_size || recipients.length,
        operationalSize: t.operational_size || null,
        postingMandal: t.posting_mandal || null,
        members: recipients.map(function (r) {
          return { personnelId: r.personnelId, name: r.name, role: r.role };
        }),
      },
      station: {
        stationId: t.station_id || null,
        stationCode: t.station_code || null,
        mandal: t.station_mandal || t.posting_mandal || null,
      },
      election: body.election || {},
      config: body.config || {},
    });
    res.json({ ok: true, teamCode: t.team_code, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Delivery report — authority/admin.
router.get('/deliveries', authorize('authority', 'admin'), (req, res) => {
  res.json({ ok: true, deliveries: service.deliveries });
});

module.exports = router;
