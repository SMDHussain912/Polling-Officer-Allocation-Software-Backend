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

/* ------------------------------------------------------------------------- *
 * Training batch read/edit endpoints (live DB; migration 009 applied).
 *   GET  /api/training/batches
 *   GET  /api/training/batches/:id/members
 *   GET  /api/training/batches/:id/locations
 *   DELETE /api/training/batches/:id/members/:personnelId  (persisted)
 *   PATCH /api/training/batches/:id/location                (admin)
 * ------------------------------------------------------------------------- */

test('unauthenticated -> 401 on batches', async () => {
  const app = buildApp(undefined);
  const { status } = await request(app, 'GET', '/api/training/batches');
  assert.equal(status, 401);
});

test('GET /batches returns array with expected shape', async () => {
  const app = buildApp(AUTHORITY);
  const { status, body } = await request(app, 'GET', '/api/training/batches');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.batches));
  if (body.batches.length > 0) {
    const b = body.batches[0];
    assert.ok('id' in b && 'batch_no' in b && 'mandal' in b && 'member_count' in b);
  }
});

test('GET /batches/:id/members returns members for a real batch', async () => {
  const app = buildApp(AUTHORITY);
  const list = await request(app, 'GET', '/api/training/batches');
  assert.ok(list.body.batches.length > 0, 'expected seeded batches');
  const id = list.body.batches[0].id;
  const { status, body } = await request(app, 'GET', `/api/training/batches/${id}/members`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.members));
  assert.ok(body.batch && body.batch.id === id);
  if (body.members.length > 0) {
    const m = body.members[0];
    assert.ok('personnel_id' in m && 'employee_id' in m && 'employee_name' in m);
    assert.ok('designation' in m && 'native_mandal' in m && 'work_mandal' in m);
  }
});

test('GET /batches/:id/members -> 404 for missing batch', async () => {
  const app = buildApp(AUTHORITY);
  const { status, body } = await request(app, 'GET', '/api/training/batches/999999/members');
  assert.equal(status, 404);
  assert.equal(body.ok, false);
});

test('GET /batches/:id/members -> 400 for non-numeric id', async () => {
  const app = buildApp(AUTHORITY);
  const { status } = await request(app, 'GET', '/api/training/batches/abc/members');
  assert.equal(status, 400);
});

test('GET /batches/:id/locations returns same-mandal candidates', async () => {
  const app = buildApp(AUTHORITY);
  const list = await request(app, 'GET', '/api/training/batches');
  const id = list.body.batches[0].id;
  const mandal = list.body.batches[0].mandal;
  const { status, body } = await request(app, 'GET', `/api/training/batches/${id}/locations`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mandal, mandal);
  assert.ok(Array.isArray(body.locations));
  for (const l of body.locations) assert.equal(l.mandal, mandal);
});

test('staff cannot assign a location (403)', async () => {
  const app = buildApp(STAFF);
  const list = await request(app, 'GET', '/api/training/batches');
  const id = list.body.batches[0].id;
  const { status } = await request(app, 'PATCH', `/api/training/batches/${id}/location`, { locationId: null });
  assert.equal(status, 403);
});

test('PATCH location rejects a location from a different mandal (400)', async () => {
  const app = buildApp(AUTHORITY);
  const list = await request(app, 'GET', '/api/training/batches');
  const id = list.body.batches[0].id;
  const mandal = list.body.batches[0].mandal;
  const pool = require('../../src/database');
  const other = await pool.query(
    'SELECT id FROM training_locations WHERE mandal <> $1 LIMIT 1', [mandal]
  );
  if (other.rows.length === 0) { return; }
  const { status, body } = await request(
    app, 'PATCH', `/api/training/batches/${id}/location`, { locationId: other.rows[0].id }
  );
  assert.equal(status, 400);
  assert.equal(body.ok, false);
});

test('PATCH location accepts null then restores (admin, round-trip)', async () => {
  const app = buildApp(AUTHORITY);
  const pool = require('../../src/database');
  const before = await pool.query('SELECT id, location_id FROM training_batches ORDER BY id LIMIT 1');
  const id = before.rows[0].id;
  const original = before.rows[0].location_id;
  try {
    const cleared = await request(app, 'PATCH', `/api/training/batches/${id}/location`, { locationId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.locationId, null);
    const mid = await pool.query('SELECT location_id FROM training_batches WHERE id = $1', [id]);
    assert.equal(mid.rows[0].location_id, null);
  } finally {
    await pool.query('UPDATE training_batches SET location_id = $1 WHERE id = $2', [original, id]);
  }
});

test('DELETE member removes + persists (admin, round-trip restore)', async () => {
  const app = buildApp(AUTHORITY);
  const list = await request(app, 'GET', '/api/training/batches');
  const withMembers = list.body.batches.find((b) => Number(b.member_count) > 0);
  assert.ok(withMembers, 'expected a batch with members');
  const id = withMembers.id;
  const mem = await request(app, 'GET', `/api/training/batches/${id}/members`);
  const victim = mem.body.members[0];
  const pool = require('../../src/database');
  try {
    const del = await request(app, 'DELETE', `/api/training/batches/${id}/members/${victim.personnel_id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.ok, true);
    const after = await pool.query(
      'SELECT 1 FROM training_batch_members WHERE batch_id = $1 AND personnel_id = $2',
      [id, victim.personnel_id]
    );
    assert.equal(after.rows.length, 0, 'member row should be gone');
  } finally {
    await pool.query(
      `INSERT INTO training_batch_members (batch_id, personnel_id, added_by_code)
       VALUES ($1, $2, FALSE) ON CONFLICT DO NOTHING`, [id, victim.personnel_id]
    );
  }
});
