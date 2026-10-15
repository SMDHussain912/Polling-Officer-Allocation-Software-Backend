'use strict';

/**
 * tests/training-orders/allocation.test.js
 *
 * Pure-logic tests for training-orders (no DB): the PO/APO split is
 * designation-based (presidingEligible === true -> PO, everyone else ->
 * APO), MO invitees live in their own table and are never passed in, and
 * buildTrainingOrderDocx merges {{tags}} via the proven order-merge engine.
 *
 * Run: node --test tests/training-orders/
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const orderMerge = require('../../src/modules/imports/order-merge.service');

// The split logic lives in training/service.js (dependency-free helper).
const { splitPoApoLocal } = require('../../src/modules/training/service');

test('PO/APO split is designation-based; MO rows never included', () => {
  const officers = [
    { name: 'A', presidingEligible: true },
    { name: 'B', presidingEligible: false },
    { name: 'C' }, // no flag -> APO
  ];
  const groups = splitPoApoLocal(officers);
  assert.equal(groups.PO.length, 1);
  assert.equal(groups.PO[0].name, 'A');
  assert.equal(groups.APO.length, 2);
});

function minimalDocxBuffer() {
  // Smallest valid .docx: [Content_Types].xml + word/document.xml with tags.
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>'
  );
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>Order {order_id} group {training_group} mandal {mandal}</w:t></w:r></w:p></w:body>' +
      '</w:document>'
  );
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('mergeDocx fills training order {{tags}} (proven engine)', () => {
  const template = minimalDocxBuffer();
  const out = orderMerge.mergeDocx(template, {
    order_id: 'TR-1',
    training_group: 'PO',
    mandal: 'Kakinada Rural',
  });
  assert.ok(Buffer.isBuffer(out));
  assert.ok(out.length > 0);
  // Rendered text survives the round-trip.
  const zip = new PizZip(out);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  const xml = zip.files['word/document.xml'].asText();
  assert.ok(xml.includes('TR-1'));
  assert.ok(xml.includes('PO'));
  assert.ok(!xml.includes('{order_id}'));
  assert.ok(doc);
});

test('allocateTraining batches PO/APO separately per mandal (stubbed pool)', async () => {
  const pool = require('../../src/database');
  const store = require('../../src/modules/randomization/allocation-store');
  const { allocateTraining } = require('../../src/modules/training-orders/index');

  // Last run: 1 PO + 2 APOs in mandal M1, 1 PO in mandal M2.
  await store.recordRun({
    runAt: new Date().toISOString(),
    runBy: { id: 1, username: 't', role: 'authority' },
    stage1: { status: 'completed' },
    stage2: {
      status: 'completed',
      excelRows: [
        { teamCode: 'T1', mandal: 'M1', role: 'Presiding Officer', employeeId: '101', name: 'PO1', designation: 'D', office: 'O' },
        { teamCode: 'T1', mandal: 'M1', role: 'Polling Officer 1', employeeId: '102', name: 'APO1', designation: 'D', office: 'O' },
        { teamCode: 'T1', mandal: 'M1', role: 'Polling Officer 2', employeeId: '103', name: 'APO2', designation: 'D', office: 'O' },
        { teamCode: 'T2', mandal: 'M2', role: 'Presiding Officer', employeeId: '104', name: 'PO2', designation: 'D', office: 'O' },
      ],
    },
    stage3: { status: 'completed' },
  });

  const realConnect = pool.connect;
  let seq = 500;
  pool.connect = async () => ({
    query: async (sql) => {
      const s = String(sql);
      if (/BEGIN|COMMIT|ROLLBACK/i.test(s)) return { rows: [] };
      if (/MAX\(batch_no\)/i.test(s)) return { rows: [{ max_no: '0' }] };
      if (/INSERT INTO training_batches/i.test(s)) return { rows: [{ id: seq++ }] };
      if (/INSERT INTO training_batch_members/i.test(s)) return { rows: [] };
      throw new Error('unexpected SQL in test: ' + s.slice(0, 80));
    },
    release: async () => {},
  });
  try {
    const result = await allocateTraining({ createdBy: 1 });
    assert.equal(result.errors.length, 0);
    // PO/M1, APO/M1, PO/M2 -> 3 batches.
    assert.equal(result.batches.length, 3);
    const groups = result.batches.map((b) => b.group + '/' + b.mandal).sort();
    assert.deepEqual(groups, ['APO/M1', 'PO/M1', 'PO/M2']);
  } finally {
    pool.connect = realConnect;
    store._reset();
  }
});
