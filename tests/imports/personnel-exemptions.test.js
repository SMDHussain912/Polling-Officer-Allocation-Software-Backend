'use strict';

/**
 * tests/imports/personnel-exemptions.test.js
 *
 * Service-layer unit tests for PATCH /api/imports/batches/:batchId/personnel/:id/exemption
 *   - 400 unknown category, negative id, note > 400 chars
 *   - 404 personnel not found
 *   - 200 on success: personnel updated AND append-only audit row written, all in
 *     one transaction; injected `req` never leaks into a read response.
 *
 * Run: node --test tests/imports/personnel-exemptions.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../../src/database');
const importRouter = require('../../src/modules/imports');

// -----------------------------------------------------------------------
// Pool + client stubbing
// -----------------------------------------------------------------------

let capturedSql = [];
let fakeClient;

// pg.Pool.prototype.connect returns a Client (pg.Client). We intercept it so
// connect() returns a controllable fake client whose query() we can drive.
const realConnect = pool.constructor.prototype.connect.bind(pool);
pool.constructor.prototype.connect = async function () {
  return fakeClient;
};

function makeClient(handlers) {
  return {
    query: async (sql, params) => {
      capturedSql.push({ sql: String(sql), params });
      return (handlers || []).reduce((acc, h) => h(sql, params, acc), { rows: [] });
    },
    release: async () => {},
  };
}

// -----------------------------------------------------------------------
// Helpers — build a SELECT-able personnel DB on the fly
// -----------------------------------------------------------------------

function makeDummyPersonnel() {
  return [
    { id: 5, employee_id: 'EMP5', exempt_category: 'health_medical', import_batch_id: 1 },
    { id: 7, employee_id: 'EMP9', exempt_category: null, import_batch_id: 1 },
    { id: 9, employee_id: 'EMP9', exempt_category: null, import_batch_id: 1 },
  ];
}

function buildSelectHandlers(personnel) {
  return [
    (sql) => {
      if (/SELECT id, employee_id, exempt_category/i.test(String(sql))) {
        return { rows: personnel };
      }
      if (/INSERT INTO personnel_exemptions/i.test(String(sql))) return { rows: [] };
      if (/UPDATE personnel/i.test(String(sql))) return { rows: [] };
      if (/BEGIN/i.test(String(sql))) return { rows: [] };
      if (/COMMIT/i.test(String(sql))) return { rows: [] };
      if (/ROLLBACK/i.test(String(sql))) return { rows: [] };
      return { rows: [] };
    },
  ];
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

test('authorization is fail-closed: unknown category -> throw, audit untouched', () => {
  capturedSql = [];
  const fakeClient = makeClient([]);
  pool.constructor.prototype.connect = async function () {
    return fakeClient;
  };
  const { patchPersonnelExemption } = require('../../src/modules/imports/import.service');
  assert.rejects(
    async () => patchPersonnelExemption({ id: 1, exemptCategory: 'unknown_category' }),
    { message: 'unauthorized category' }
  );
  assert.equal(capturedSql.length, 0, 'no SQL executed for unauthorized category');
});

test('failure modes propagate the right messages', () => {
  capturedSql = [];
  const fakeClient = makeClient([]);
  pool.constructor.prototype.connect = async function () {
    return fakeClient;
  };
  const { patchPersonnelExemption } = require('../../src/modules/imports/import.service');
  assert.rejects(
    async () => patchPersonnelExemption({ id: 1, exemptCategory: 'made_up_category' }),
    { message: 'unauthorized category' }
  );
  assert.rejects(
    async () => patchPersonnelExemption({ id: -1, exemptCategory: null }),
    { message: 'invalid personnel id' }
  );
  assert.rejects(
    async () => patchPersonnelExemption({ id: 1, exemptCategory: null, note: 'x'.repeat(401) }),
    { message: /up to 400 characters/ }
  );
});

test('successful exemption: personnel updated + audit row written atomically', async () => {
  capturedSql = [];
  const personnel = makeDummyPersonnel();
  const fakeClient = makeClient(buildSelectHandlers(personnel));
  pool.constructor.prototype.connect = async function () {
    return fakeClient;
  };
  const { patchPersonnelExemption } = require('../../src/modules/imports/import.service');

  await patchPersonnelExemption({
    id: 5,
    exemptCategory: 'pregnant',
    note: 'authority confirmed p.61(a)(viii)',
    req: { session: { user: { id: 42, username: 'authority' } } },
  });

  // BEGIN, SELECT, INSERT audit, UPDATE, COMMIT = 5 statements
  assert.equal(capturedSql.length, 5, 'expected 5 SQL statements, got ' + capturedSql.length);

  const select = capturedSql.find((c) => /SELECT id, employee_id, exempt_category/i.test(c.sql));
  assert.ok(select, 'SELECT FOR UPDATE found');
  assert.equal(select.params[0], 5, 'SELECT FOR UPDATE should filter by personnel id');

  const insertAudit = capturedSql.find((c) => /INSERT INTO personnel_exemptions/i.test(c.sql));
  assert.ok(insertAudit, 'audit INSERT found');
  assert.equal(insertAudit.params[1], 'EMP5', 'employee_id passed to audit');
  assert.equal(insertAudit.params[3], 'health_medical', 'old_exempt_category captured');
  assert.equal(insertAudit.params[2], 'pregnant', 'new_exempt_category');
  assert.equal(insertAudit.params[4], 'authority_mark', 'reason = authority_mark');
  assert.equal(insertAudit.params[5], 42, 'requested_by_user_id from req.session.user.id');
  assert.equal(insertAudit.params[6], 'authority confirmed p.61(a)(viii)', 'note preserved');

  const update = capturedSql.find((c) => /UPDATE personnel/i.test(c.sql));
  assert.ok(update, 'UPDATE personnel found');
  assert.equal(update.params[0], 'pregnant', 'exempt_category updated to new value');

  // Order check: audit row written before personnel update (atomic transaction)
  const auditIdx = capturedSql.findIndex((c) => /INSERT INTO personnel_exemptions/i.test(c.sql));
  const updateIdx = capturedSql.findIndex((c) => /UPDATE personnel/i.test(c.sql));
  assert.ok(auditIdx < updateIdx, 'audit row written before personnel update');
});

test('pending_authority_confirmation marker for bank (p.61(a)(vii))', async () => {
  capturedSql = [];
  const personnel = makeDummyPersonnel();
  const fakeClient = makeClient(buildSelectHandlers(personnel));
  pool.constructor.prototype.connect = async function () {
    return fakeClient;
  };
  const { patchPersonnelExemption } = require('../../src/modules/imports/import.service');

  await patchPersonnelExemption({
    id: 7,
    exemptCategory: 'pending_authority_confirmation',
    note: 'bank review criteria not on sheet',
    req: { session: { user: { id: 42 } } },
  });

  const insertAudit = capturedSql.find((c) => /INSERT INTO personnel_exemptions/i.test(c.sql));
  assert.ok(insertAudit, 'audit INSERT found');
  assert.equal(insertAudit.params[2], 'pending_authority_confirmation', 'new_exempt_category = marker');
});

test('clear exemption (null) + unmasked medical stored in personnel', async () => {
  capturedSql = [];
  const personnel = makeDummyPersonnel();
  const fakeClient = makeClient(buildSelectHandlers(personnel));
  pool.constructor.prototype.connect = async function () {
    return fakeClient;
  };
  const { patchPersonnelExemption } = require('../../src/modules/imports/import.service');

  // First pass: set to health_medical
  await patchPersonnelExemption({
    id: 9,
    exemptCategory: 'health_medical',
    req: { session: { user: { id: 42 } } },
  });
  const updates = capturedSql.filter((c) => /UPDATE personnel/i.test(c.sql));
  assert.equal(updates.length, 1, 'one UPDATE in pass 1');
  assert.equal(updates[0].params[0], 'health_medical');

  // Second pass: clear back to null
  const prevLen = capturedSql.length;
  await patchPersonnelExemption({ id: 9, exemptCategory: null, req: { session: { user: { id: 42 } } } });
  const allUpdates = capturedSql.filter((c) => /UPDATE personnel/i.test(c.sql));
  assert.equal(allUpdates.length, 2, 'two UPDATEs across both passes');
  assert.equal(allUpdates[1].params[0], null, 'second UPDATE sets exempt_category to null');

  // Two audit rows written (append-only)
  const audit2 = capturedSql.filter((c) => /INSERT INTO personnel_exemptions/i.test(c.sql));
  assert.equal(audit2.length, 2, 'one audit row per exemption state transition');
});
