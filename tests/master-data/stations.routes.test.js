'use strict';

/**
 * tests/master-data/stations.routes.test.js
 *
 * Verifies the polling-station routes with a real Express round-trip and a
 * stubbed pool (no live database):
 *   POST /stations          -> authority, admin
 *   GET  /stations          -> staff, authority, admin
 *   GET  /stations/batches  -> staff, authority, admin
 * Unauthenticated -> 401; wrong role -> 403; allowed role reaches handler.
 *
 * Run: node --test tests/master-data/stations.routes.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const express = require('express');
const pool = require('../../src/database');
const masterDataRouter = require('../../src/modules/master-data');

// --- pool stubs (never touch PostgreSQL) ------------------------------------
const realQuery = pool.query;
const realConnect = pool.connect;

// Module-level capture of polling_stations INSERT parameter arrays.
let capturedInserts = [];

pool.connect = async () => {
  const client = {
    async query(sql, params) {
      if (/INSERT INTO import_batches/i.test(sql)) {
        return { rows: [{ id: 42 }] };
      }
      if (/INSERT INTO polling_stations/i.test(sql)) {
        // Capture inserted values so tests can assert correct column mapping.
        capturedInserts.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return client;
};

pool.query = async (sql) => {
  if (/SELECT b\.id, b\.file_name.*kind = 'stations'/is.test(sql)) {
    return { rows: [{ id: 42, file_name: 'stations.json', total_rows: 1, accepted_rows: 1, rejected_rows: 0, status: 'completed', kind: 'stations', imported_at: '2026-01-01T00:00:00Z', imported_by: 'tester' }] };
  }
  if (/FROM polling_stations/i.test(sql)) {
    return { rows: [{ id: 1, import_batch_id: 42, district: 'Kakinada', station_id: 'B1', station_number: '1', station_name: 'Govt School', building_name: null, street: null, locality: null, ward: null, mandal: 'Peddapuram', pin_code: '533005', required_officers: 5 }] };
  }
  return { rows: [] };
};

function buildApp(user) {
  const app = express();
  app.use(express.json());
  if (user !== undefined) {
    app.use((req, _res, next) => { req.session = { user }; next(); });
  }
  app.use('/api/master-data', masterDataRouter);
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

const validStation = { stationId: 'B1', stationNumber: '1', stationName: 'Govt School', mandal: 'Peddapuram', district: 'Kakinada' };

// --- POST /stations: authority, admin ---------------------------------------
test('POST /stations: unauthenticated -> 401', async () => {
  const { status } = await request(buildApp(undefined), 'POST', '/api/master-data/stations', { fileName: 's.json', stations: [validStation] });
  assert.equal(status, 401);
});

test('POST /stations: staff -> 403 (denied)', async () => {
  const { status, body } = await request(buildApp({ id: 1, role: 'staff' }), 'POST', '/api/master-data/stations', { fileName: 's.json', stations: [validStation] });
  assert.equal(status, 403);
  assert.equal(body.error, 'Forbidden');
});

test('POST /stations: authority -> 200 (import succeeds)', async () => {
  const { status, body } = await request(buildApp({ id: 1, role: 'authority' }), 'POST', '/api/master-data/stations', { fileName: 's.json', stations: [validStation] });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.batch.id, 42);
  assert.equal(body.batch.acceptedRows, 1);
});

test('POST /stations: admin -> 200', async () => {
  const { status } = await request(buildApp({ id: 1, role: 'admin' }), 'POST', '/api/master-data/stations', { fileName: 's.json', stations: [validStation] });
  assert.equal(status, 200);
});

test('POST /stations: maps camelCase input to correct DB columns (no NULLs in NOT NULL cols)', async () => {
  capturedInserts = [];
  const station = {
    stationId: 'B99', stationNumber: '99', stationName: 'ZPH School',
    mandal: 'Peddapuram', district: 'Kakinada',
    buildingName: 'Main', street: 'Road 1', locality: 'Village', ward: 'W2',
    pinCode: '533005', requiredOfficers: 4,
  };
  const { status } = await request(buildApp({ id: 1, role: 'authority' }), 'POST', '/api/master-data/stations', { fileName: 's.json', stations: [station] });
  assert.equal(status, 200);
  assert.equal(capturedInserts.length, 1, 'one polling_stations INSERT');
  // params = [batchId, district, station_id, station_number, station_name,
  //           building_name, street, locality, ward, mandal, pin_code, required_officers]
  const params = capturedInserts[0];
  assert.equal(params[0], 42, 'batchId first');
  assert.equal(params[1], 'Kakinada', 'district');
  assert.equal(params[2], 'B99', 'station_id must not be NULL');
  assert.equal(params[3], '99', 'station_number must not be NULL');
  assert.equal(params[4], 'ZPH School', 'station_name must not be NULL');
  assert.equal(params[5], 'Main', 'building_name');
  assert.equal(params[6], 'Road 1', 'street');
  assert.equal(params[7], 'Village', 'locality');
  assert.equal(params[8], 'W2', 'ward');
  assert.equal(params[9], 'Peddapuram', 'mandal must not be NULL');
  assert.equal(params[10], '533005', 'pin_code');
  assert.equal(params[11], 4, 'required_officers');
  // Nothing in the required set may be null.
  for (const i of [1, 2, 3, 4, 9]) {
    assert.notEqual(params[i], null, `param[${i}] must not be null`);
  }
});

test('POST /stations: missing fileName -> 400 (validation after authz)', async () => {
  const { status } = await request(buildApp({ id: 1, role: 'authority' }), 'POST', '/api/master-data/stations', { stations: [validStation] });
  assert.equal(status, 400);
});

test('POST /stations: stations not an array -> 400', async () => {
  const { status } = await request(buildApp({ id: 1, role: 'authority' }), 'POST', '/api/master-data/stations', { fileName: 's.json', stations: 'nope' });
  assert.equal(status, 400);
});

test('POST /stations: empty stations array -> 400', async () => {
  const { status } = await request(buildApp({ id: 1, role: 'authority' }), 'POST', '/api/master-data/stations', { fileName: 's.json', stations: [] });
  assert.equal(status, 400);
});

// --- GET /stations: staff, authority, admin ---------------------------------
test('GET /stations: unauthenticated -> 401', async () => {
  const { status } = await request(buildApp(undefined), 'GET', '/api/master-data/stations');
  assert.equal(status, 401);
});

test('GET /stations: staff allowed -> 200 with stations', async () => {
  const { status, body } = await request(buildApp({ id: 1, role: 'staff' }), 'GET', '/api/master-data/stations');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.count, 1);
  assert.equal(body.stations[0].station_id, 'B1');
});

test('GET /stations: unknown role -> 403', async () => {
  const { status } = await request(buildApp({ id: 1, role: 'guest' }), 'GET', '/api/master-data/stations');
  assert.equal(status, 403);
});

test('GET /stations: invalid batchId -> 400', async () => {
  const { status } = await request(buildApp({ id: 1, role: 'staff' }), 'GET', '/api/master-data/stations?batchId=abc');
  assert.equal(status, 400);
});

// --- GET /stations/batches --------------------------------------------------
test('GET /stations/batches: staff allowed -> 200', async () => {
  const { status, body } = await request(buildApp({ id: 1, role: 'staff' }), 'GET', '/api/master-data/stations/batches');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.batches[0].kind, 'stations');
});

test('GET /stations/batches: unauthenticated -> 401', async () => {
  const { status } = await request(buildApp(undefined), 'GET', '/api/master-data/stations/batches');
  assert.equal(status, 401);
});

test.after(() => { pool.query = realQuery; pool.connect = realConnect; });
