'use strict';

/**
 * tests/imports/personnel-read.test.js
 *
 * GET /api/imports/batches/:id/personnel — behavior over a real Express
 * round-trip with a stubbed pool (no live database). Covers:
 *   - 401 without a session (requireAuth fail-closed)
 *   - 400 on an invalid batch id
 *   - 404 on an unknown batch
 *   - 200 with the batch summary + personnel list
 *   - the personnel SQL never selects aadhar_number / voter_id / mobile_no
 *
 * Run: node --test tests/imports/personnel-read.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const pool = require('../../src/database');
const importsRouter = require('../../src/modules/imports');

// Intercept pool.query so tests never touch PostgreSQL; capture SQL per call.
let capturedSql = [];
let handler = async () => ({ rows: [] });
const realQuery = pool.query;
pool.query = async (sql, params) => {
  capturedSql.push(String(sql));
  return handler(sql, params);
};

function buildApp({ withSession }) {
  const app = express();
  app.use(express.json());
  if (withSession) {
    app.use((req, _res, next) => {
      req.session = { user: { id: 1, username: 'tester', role: 'authority' } };
      next();
    });
  }
  app.use('/api/imports', importsRouter);
  return app;
}

async function request(app, method, path) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const SENSITIVE = ['aadhar_number', 'voter_id', 'mobile_no'];

test('unauthenticated request is rejected (401) and no query runs', async () => {
  capturedSql = [];
  handler = async () => ({ rows: [] });
  const app = buildApp({ withSession: false });
  const { status, body } = await request(app, 'GET', '/api/imports/batches/1/personnel');
  assert.equal(status, 401);
  assert.equal(body.ok, false);
  assert.equal(capturedSql.length, 0, 'requireAuth must block before any DB query');
});

test('invalid batch id -> 400, no query runs', async () => {
  capturedSql = [];
  handler = async () => ({ rows: [] });
  const app = buildApp({ withSession: true });
  for (const bad of ['abc', '0', '-3']) {
    capturedSql = [];
    const { status, body } = await request(app, 'GET', `/api/imports/batches/${bad}/personnel`);
    assert.equal(status, 400, `id "${bad}" should be 400`);
    assert.equal(body.ok, false);
    assert.equal(capturedSql.length, 0, 'invalid id must not query the DB');
  }
});

test('unknown batch -> 404', async () => {
  capturedSql = [];
  handler = async () => ({ rows: [] });
  const app = buildApp({ withSession: true });
  const { status, body } = await request(app, 'GET', '/api/imports/batches/999/personnel');
  assert.equal(status, 404);

test('known batch -> 200 with batch summary and personnel rows', async () => {
  capturedSql = [];
  handler = async (sql) => {
    if (/FROM import_batches/i.test(sql)) {
      return { rows: [{ id: 7, file_name: 'proforma.xlsx', department_name: 'Education',
        total_rows: 2, accepted_rows: 2, status: 'completed', imported_at: '2026-01-01T00:00:00Z' }] };
    }
    return { rows: [
      { id: 1, employee_id: 'EMP1', employee_name: 'Alpha', designation: 'Teacher',
        gender: 'F', gazetted_status: 'Non-Gazetted', work_mandal: 'Kakinada',
        native_mandal: 'Peddapuram', working_constituency_name: 'Kakinada', import_status: 'accepted' },
    ] };
  };
  const app = buildApp({ withSession: true });
  const { status, body } = await request(app, 'GET', '/api/imports/batches/7/personnel');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.batch.id, 7);
  assert.equal(body.count, 1);
  assert.equal(body.personnel.length, 1);
  assert.equal(body.personnel[0].employeeId, 'EMP1');
  assert.equal(body.personnel[0].employeeName, 'Alpha');
  assert.equal(body.personnel[0].workMandal, 'Kakinada');
});

test('personnel rows are projected to a camelCase allow-list (no snake_case leak)', async () => {
  capturedSql = [];
  handler = async (sql) => {
    if (/FROM import_batches/i.test(sql)) return { rows: [{ id: 7 }] };
    return { rows: [
      { id: 1, employee_id: 'EMP1', employee_name: 'Alpha', designation: 'Teacher',
        gender: 'F', gazetted_status: 'Non-Gazetted', work_mandal: 'Kakinada',
        native_mandal: 'Peddapuram', working_constituency_name: 'Kakinada', import_status: 'accepted' },
    ] };
  };
  const app = buildApp({ withSession: true });
  const { body } = await request(app, 'GET', '/api/imports/batches/7/personnel');
  const row = body.personnel[0];
  // Only allow-listed keys are present.
  assert.deepEqual(Object.keys(row).sort(), [
    'designation', 'employeeId', 'employeeName', 'gazettedStatus', 'gender',
    'id', 'importStatus', 'nativeMandal', 'workMandal', 'workingConstituencyName',
  ]);
});

test('personnel SQL never selects sensitive columns', async () => {
  capturedSql = [];
  handler = async (sql) => (/FROM import_batches/i.test(sql) ? { rows: [{ id: 7 }] } : { rows: [] });
  const app = buildApp({ withSession: true });
  await request(app, 'GET', '/api/imports/batches/7/personnel');

  const personnelSql = capturedSql.find((s) => /FROM personnel/i.test(s));
  assert.ok(personnelSql, 'a personnel query must have run');
  for (const col of SENSITIVE) {
    assert.ok(!new RegExp(col, 'i').test(personnelSql), `personnel query must NOT select ${col}`);
  }
});

test('response objects never leak sensitive values (defense-in-depth)', async () => {
  capturedSql = [];
  handler = async (sql) => {
    if (/FROM import_batches/i.test(sql)) return { rows: [{ id: 7 }] };
    return { rows: [
      { id: 1, employee_id: 'EMP1', aadhar_number: 'SECRET-AADHAAR',
        voter_id: 'SECRET-EPIC', mobile_no: 'SECRET-MOBILE' },
    ] };
  };
  const app = buildApp({ withSession: true });
  const { body } = await request(app, 'GET', '/api/imports/batches/7/personnel');
  const serialized = JSON.stringify(body);
  for (const secret of ['SECRET-AADHAAR', 'SECRET-EPIC', 'SECRET-MOBILE']) {
    assert.ok(!serialized.includes(secret), `response leaked ${secret}`);
  }
});

test.after(() => {
  pool.query = realQuery;
});

  assert.equal(body.ok, false);
});
