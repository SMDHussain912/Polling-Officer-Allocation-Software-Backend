'use strict';

/**
 * tests/training/routes.test.js
 *
 * Verifies training session creation validation + attendance marking +
 * authorization. Service is in-memory (migration 005 unapplied).
 *
 * Run: node --test tests/training/routes.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const trainingRouter = require('../../src/modules/training');

function buildApp(user) {
  const app = express();
  app.use(express.json());
  if (user !== undefined) {
    app.use((req, _res, next) => { req.session = { user }; next(); });
  }
  app.use('/api/training', trainingRouter);
  return app;
}

async function request(app, method, path, body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const AUTHORITY = { id: 1, username: 'auth1', role: 'authority' };
const STAFF = { id: 2, username: 'staff1', role: 'staff' };

test('unauthenticated -> 401 on sessions', async () => {
  const app = buildApp(undefined);
  const { status } = await request(app, 'GET', '/api/training/sessions');
  assert.equal(status, 401);
});

test('staff can list sessions but cannot create', async () => {
  const app = buildApp(STAFF);
  const listed = await request(app, 'GET', '/api/training/sessions');
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.sessions));
  const denied = await request(app, 'POST', '/api/training/sessions', { title: 'X' });
  assert.equal(denied.status, 403);
});

test('authority creates a session; validation rejects bad type', async () => {
  const app = buildApp(AUTHORITY);
  const ok = await request(app, 'POST', '/api/training/sessions', {
    title: 'PO practical class 1',
    sessionType: 'practical',
    mandal: 'Tuni',
    durationMinutes: 60,
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.session.title, 'PO practical class 1');
  assert.ok(ok.body.session.id > 0);

  const bad = await request(app, 'POST', '/api/training/sessions', {
    title: 'Bad session', sessionType: 'exam',
  });
  assert.equal(bad.status, 400);
});

test('attendance marking + reading works (incl. reserve + MO role)', async () => {
  const app = buildApp(AUTHORITY);
  const created = await request(app, 'POST', '/api/training/sessions', {
    title: 'Attendance demo', sessionType: 'theory',
  });
  const id = created.body.session.id;
  const marked = await request(app, 'POST', `/api/training/sessions/${id}/attendance`, {
    records: [
      { personnelId: 'E1', present: true, role: 'Presiding Officer' },
      { personnelId: 'E2', present: true, role: 'Micro Observer' },
      { personnelId: 'E3', present: false, role: '1st Polling Officer', isReserve: true },
    ],
  });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.attendance.length, 3);

  const read = await request(app, 'GET', `/api/training/sessions/${id}/attendance`);
  assert.equal(read.status, 200);
  assert.equal(read.body.attendance.length, 3);
  const mo = read.body.attendance.find((a) => a.personnelId === 'E2');
  assert.equal(mo.role, 'Micro Observer');
});
