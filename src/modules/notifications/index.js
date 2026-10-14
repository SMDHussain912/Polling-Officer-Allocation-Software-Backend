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
const { createFast2smsProvider, createWhatsAppProvider, createGmailProvider } = require('./providers');
const { createNotificationService } = require('./service');

const router = express.Router();
router.use(requireAuth);

const service = createNotificationService({
  providers: [createFast2smsProvider(), createWhatsAppProvider(), createGmailProvider()],
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

// Delivery report — authority/admin.
router.get('/deliveries', authorize('authority', 'admin'), (req, res) => {
  res.json({ ok: true, deliveries: service.deliveries });
});

module.exports = router;
