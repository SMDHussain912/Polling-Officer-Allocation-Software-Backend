'use strict';

/**
 * tests/imports/personnel-edit.test.js
 *
 * Service + route tests for PATCH /api/imports/personnel/:id (admin edit).
 * Stubs the pg pool (both query + connect) so no live DB is touched.
 *
 * Covers: allow-list enforcement (identity/sensitive columns never written),
 * email shape validation, 404 unknown id, partial update, no-op when nothing
 * editable supplied, and route authorization (401/403).
 *
 * Run: node --test tests/imports/personnel-edit.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const pool = require('../../src/database');
const importsRouter = require('../../src/modules/imports');
const { editPersonnel, EDITABLE } = require('../../src/modules/imports/personnel-edit.service');

// --- controllable fake pool -------------------------------------------------
let personnelExists = true;
let lastUpdate = null; // { sql, params }

function runFake(sql, params) {
  const s = String(sql);
  if (/^\s*BEGIN/i.test(s) || /^\s*COMMIT/i.test(s) || /^\s*ROLLBACK/i.test(s)) return { rows: [] };
  if (/SELECT id FROM personnel WHERE id = /i.test(s)) {
    return { rows: personnelExists ? [{ id: params[0] }] : [] };
  }
  if (/UPDATE personnel SET/i.test(s)) {
    lastUpdate = { sql: s, params };
    return { rows: [] };
  }
  return { rows: [] };
}

const realQuery = pool.query;
const realConnect = pool.constructor.prototype.connect.bind(pool);
pool.query = async (sql, params) => runFake(sql, params);
pool.constructor.prototype.connect = async function () {
  return { query: async (sql, params) => runFake(sql, params), release: async () => {} };
};

function reset() { personnelExists = true; lastUpdate = null; }

function buildApp(user) {
  const app = express();
  app.use(express.json());
  if (user !== undefined) app.use((req, _res, next) => { req.session = { user }; next(); });
  app.use('/api/imports', importsRouter);
  return app;
}

async function request(app, method, path, body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
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
    await new Promise((r) => server.close(r));
  }
}

const AUTHORITY = { id: 1, username: 'auth1', role: 'authority' };
const STAFF = { id: 2, username: 'staff1', role: 'staff' };

// --- service-level ----------------------------------------------------------

test('service: writes only allow-listed fields; ignores identity/sensitive', async () => {
  reset();
  const res = await editPersonnel({
    id: 5,
    fields: {
      mobile_no: '9876543210',
      designation: 'Senior Assistant',
      // must be IGNORED (not in allow-list; email column removed with the mail system):
      email: 'asha@example.gov',
      employee_id: 'HACKED',
      employee_name: 'HACKED',
      aadhar_number: '9999',
      voter_id: 'VHACK',
      exempt_category: 'pregnant',
      import_status: 'accepted',
      id: 999,
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.id, 5);
  assert.deepEqual(res.updated.sort(), ['designation', 'mobile_no']);
  // the UPDATE SQL only references allow-listed columns
  assert.ok(lastUpdate);
  assert.ok(!/email =/i.test(lastUpdate.sql), 'email column removed with the mail system');
  assert.ok(lastUpdate.sql.includes("mobile_no = $"));
  assert.ok(lastUpdate.sql.includes("designation = $"));
  assert.ok(!/employee_id =/i.test(lastUpdate.sql));
  assert.ok(!/aadhar_number =/i.test(lastUpdate.sql));
  assert.ok(!/voter_id =/i.test(lastUpdate.sql));
  assert.ok(!/exempt_category =/i.test(lastUpdate.sql));
  assert.ok(!/import_status =/i.test(lastUpdate.sql));
  // the id lands as the final WHERE param
  assert.equal(lastUpdate.params[lastUpdate.params.length - 1], 5);
});

test('service: email is no longer editable (allow-list stripped with mail system)', async () => {
  reset();
  const res = await editPersonnel({ id: 5, fields: { email: 'not-an-email' } });
  // Unknown/removed keys are ignored — never a validation error, never written.
  assert.equal(res.ok, true);
  assert.deepEqual(res.updated, []);
});

test('service: null clears a field', async () => {
  reset();
  const res = await editPersonnel({ id: 5, fields: { remarks: null } });
  assert.deepEqual(res.updated, ['remarks']);
  // remarks null is param index 1
  assert.equal(lastUpdate.params[0], null);
});

test('service: 404 when personnel missing', async () => {
  reset();
  personnelExists = false;
  await assert.rejects(
    () => editPersonnel({ id: 999, fields: { email: 'a@b.co' } }),
    (e) => e.statusCode === 404 && /not found/.test(e.message)
  );
});

test('service: no editable fields -> no-op (still validates existence)', async () => {
  reset();
  const res = await editPersonnel({ id: 5, fields: { employee_id: 'X', aadhar_number: 'Y' } });
  assert.deepEqual(res.updated, []);
  assert.equal(lastUpdate, null); // no UPDATE issued
});

test('service: invalid id -> 400', async () => {
  reset();
  await assert.rejects(() => editPersonnel({ id: 'abc', fields: { email: 'a@b.co' } }), (e) => e.statusCode === 400);
});

// --- route-level ------------------------------------------------------------

test('route: PATCH /personnel/:id unauthenticated -> 401', async () => {
  reset();
  const { status } = await request(buildApp(undefined), 'PATCH', '/api/imports/personnel/5', { email: 'a@b.co' });
  assert.equal(status, 401);
});

test('route: PATCH /personnel/:id staff -> 403', async () => {
  reset();
  const { status } = await request(buildApp(STAFF), 'PATCH', '/api/imports/personnel/5', { email: 'a@b.co' });
  assert.equal(status, 403);
});

test('route: PATCH /personnel/:id authority -> 200 with updated list', async () => {
  reset();
  const { status, body } = await request(buildApp(AUTHORITY), 'PATCH', '/api/imports/personnel/5', { email: 'a@b.co', designation: 'SA' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  // email was stripped from the allow-list with the mail system — ignored, not written
  assert.deepEqual(body.updated.sort(), ['designation']);
});

test('route: PATCH removed email field -> 200 ignored (mail system removed)', async () => {
  reset();
  const { status, body } = await request(buildApp(AUTHORITY), 'PATCH', '/api/imports/personnel/5', { email: 'bad' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.updated, []);
});

test.after(() => {
  pool.query = realQuery;
  pool.constructor.prototype.connect = realConnect;
});
