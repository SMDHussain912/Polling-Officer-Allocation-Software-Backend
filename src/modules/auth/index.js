const express = require('express');
const bcrypt = require('bcrypt');
const svgCaptcha = require('svg-captcha');
const Limiter = require('express-rate-limiter');
const MemoryStore = require('express-rate-limiter/lib/memoryStore');
const pool = require('../../database');
const { requireAuth } = require('../../middleware/auth');

const router = express.Router();

const loginLimiter = new Limiter({ db: new MemoryStore() });

router.get('/captcha', (req, res) => {
  const captcha = svgCaptcha.create({ size: 4, noise: 2, ignoreChars: '0o1lI' });
  req.session.captcha = captcha.text.toLowerCase();
  res.set('Content-Type', 'image/svg+xml');
  res.send(captcha.data);
});

router.post('/login', loginLimiter.middleware(), async (req, res) => {
  const { username, password, captcha } = req.body || {};

  if (!username || !password || !captcha) {
    return res.status(400).json({ ok: false, error: 'Username, password and captcha are required' });
  }

  const expectedCaptcha = req.session.captcha;
  delete req.session.captcha; // one attempt per captcha

  if (!expectedCaptcha || String(captcha).trim().toLowerCase() !== expectedCaptcha) {
    return res.status(400).json({ ok: false, error: 'Invalid captcha' });
  }

  const { rows } = await pool.query(
    'SELECT u.id, u.username, u.password_hash, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = $1',
    [username]
  );

  const user = rows[0];
  const passwordOk = user ? await bcrypt.compare(password, user.password_hash) : false;

  if (!user || !passwordOk) {
    return res.status(401).json({ ok: false, error: 'Invalid username or password' });
  }

  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).json({ ok: false, error: 'Failed to create session' });
    }
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ ok: true, user: req.session.user });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.session.user });
});

module.exports = router;
