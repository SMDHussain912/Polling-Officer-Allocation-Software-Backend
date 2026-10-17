'use strict';

/** tests/imports/template-test.cjs — order template / order config /
 *  idcard design service tests (chained pool). Run: node --test tests/imports/template-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const poolMod = require('../../src/database');

function makeClient() {
  return {
    query: async (sql, params) => {
      capturedSql.push({ sql: String(sql), params });
      return { rows: [] };
    },
    release: async () => {},
  };
}

let capturedSql = [];

function withCapturedPool(fn) {
  const origConnect = poolMod.connect;
  poolMod.connect = async () => makeClient();
  return fn().finally(() => {
    poolMod.connect = origConnect;
    capturedSql = [];
  });
}

test('template service: upload replaces the kind-row, only one active', async () => {
  await withCapturedPool(async () => {
    const { upsertOrderTemplate } = require('../../src/modules/imports/intake.service');
    await upsertOrderTemplate({
      kind: 'polling_team',
      display_name: 'Polling Team Order 2026',
      file_name: 'polling-team.docx',
      file: Buffer.from('PK'),
      uploadedBy: 3,
    });
    const inserts = capturedSql.filter((c) => /INSERT INTO order_templates/i.test(c.sql));
    assert.equal(inserts.length, 1);
    assert.ok(
      capturedSql.find((c) => /ON CONFLICT \(kind\)/i.test(c.sql)),
      'conflict update used by kind'
    );
    assert.ok(
      capturedSql.find((c) => /UPDATE order_templates.*active = FALSE/i.test(c.sql)),
      'deactivate other active kind'
    );
  });
});

test('template service: order config + idcard design upsert transactionally', async () => {
  await withCapturedPool(async () => {
    const { upsertOrderConfig, upsertIdCardDesign } = require('../../src/modules/imports/intake.service');
    await upsertOrderConfig({
      config: { election_title: 'Mahajan', district: 'Kakinada' },
      updatedBy: 3,
    });
    await upsertIdCardDesign({
      design: { headerTitle: 'D' },
      updatedBy: 3,
    });
    const config = capturedSql.find((c) => /INSERT INTO order_config/i.test(c.sql));
    assert.ok(config, 'order config insert ran');
    const card = capturedSql.find((c) => /INSERT INTO id_card_design/i.test(c.sql));
    assert.ok(card, 'idcard design insert ran');
  });
});

test('template service: design read-back via real DB', async () => {
  const { upsertIdCardDesign } = require('../../src/modules/imports/intake.service');
  await upsertIdCardDesign({ design: { headerTitle: 'D', body: 'B' }, updatedBy: 3 });
  const { rows } = await poolMod.query(`SELECT design FROM id_card_design WHERE id = 1`);
  assert.equal(rows.length, 1);
  const design = rows[0].design;
  if (typeof design === 'string') {
    assert.deepEqual(JSON.parse(design), { headerTitle: 'D', body: 'B' });
  } else {
    assert.deepEqual(design, { headerTitle: 'D', body: 'B' });
  }
});

test('order-config upsert + read-back via real DB', async () => {
  const { upsertOrderConfig } = require('../../src/modules/imports/intake.service');
  await upsertOrderConfig({
    config: { election_title: 'Mahajan', district: 'Kakinada' },
    updatedBy: 3,
  });
  const { rows } = await poolMod.query(`SELECT election_title, district FROM order_config WHERE id = 1`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].election_title, 'Mahajan');
  assert.equal(rows[0].district, 'Kakinada');
});
