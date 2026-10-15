'use strict';

/**
 * tests/training-orders/order-print.test.js
 *
 * End-to-end tests for the training-orders print/export flow:
 *   1. Seed po_training_batches / po_training_batch_members (and APO) with real
 *      personnel from the DB.
 *   2. Call generateOrders() -> merges the real built-in .docx template ->
 *      stores order_docx Buffer in DB.
 *   3. Verify order_docx IS NOT NULL and is a valid DOCX.
 *   4. Call downloadTrainingOrder() -> verify returned buffer is a valid DOCX.
 *   5. Call buildOrdersZip() -> verify returned ZIP contains valid DOCX files.
 *   6. Clean up all seed data.
 *
 * Runs against the live DATABASE_URL (same as the dev server). All seed data
 * is deleted in finally blocks so the test is self-cleaning.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const pool = require('../../src/database');
const {
  generateOrders,
  downloadTrainingOrder,
  buildOrdersZip,
} = require('../../src/modules/training-orders/index');

const PO_TEMPLATE = path.join(__dirname, '../../docs/po-order-tagged.docx');
const APO_TEMPLATE = path.join(__dirname, '../../docs/apo-order-tagged.docx');

function isDocx(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  );
}

function isZip(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  );
}

async function seedGroup(client, group, mandal, n) {
  const t =
    group === 'PO'
      ? { batches: 'po_training_batches', members: 'po_training_batch_members' }
      : { batches: 'apo_training_batches', members: 'apo_training_batch_members' };

  const b = await client.query(
    `INSERT INTO ${t.batches} (batch_no, mandal, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [1, mandal, null]
  );
  const batchId = b.rows[0].id;

  const personnel = await client.query(
    `SELECT id, employee_id, employee_name, designation, work_mandal, mobile_no
       FROM personnel
      WHERE work_mandal = $1
      LIMIT $2`,
    [mandal, n]
  );

  let inserted = 0;
  for (const p of personnel.rows) {
    await client.query(
      `INSERT INTO ${t.members} (batch_id, personnel_id, employee_id, role, team_code, added_by_code)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT DO NOTHING`,
      [
        batchId,
        p.id,
        p.employee_id,
        group === 'PO' ? 'Presiding Officer' : 'Asst. Presiding Officer',
        'T1',
      ]
    );
    inserted += 1;
  }
  return { batchId, inserted, personnelCount: personnel.rows.length };
}

async function cleanupAll(client) {
  await client.query('DELETE FROM po_training_orders');
  await client.query('DELETE FROM apo_training_orders');
  await client.query('DELETE FROM po_training_batch_members');
  await client.query('DELETE FROM apo_training_batch_members');
  await client.query('DELETE FROM po_training_batches');
  await client.query('DELETE FROM apo_training_batches');
}
test('generateOrders stores valid order_docx for PO and APO (real template, real DB)', async (t) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await cleanupAll(client);

    await seedGroup(client, 'PO', 'Kakinada', 3);
    await seedGroup(client, 'APO', 'Kakinada', 3);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  try {
    // ---- PO ----
    const poResult = await generateOrders({ group: 'PO', createdBy: null });
    assert.equal(poResult.group, 'PO');
    assert.ok(poResult.generated > 0, 'PO should generate at least one order');
    assert.equal(poResult.errors.length, 0, 'PO generate should have no errors');

    const poOrders = await pool.query(
      `SELECT id, order_id, sl_no, employee_id, employee_name, order_docx,
              octet_length(order_docx) AS docx_size
         FROM po_training_orders
        ORDER BY sl_no`
    );
    assert.equal(poOrders.rows.length, poResult.generated, 'PO order rows should match generated count');
    for (const o of poOrders.rows) {
      assert.ok(o.order_docx, `PO order ${o.order_id} must have order_docx`);
      assert.ok(isDocx(o.order_docx), `PO order ${o.order_id} order_docx must be a valid DOCX`);
      assert.ok(o.docx_size > 1000, `PO order ${o.order_id} DOCX should be non-trivial`);
    }

    // ---- APO ----
    const apoResult = await generateOrders({ group: 'APO', createdBy: null });
    assert.equal(apoResult.group, 'APO');
    assert.ok(apoResult.generated > 0, 'APO should generate at least one order');
    assert.equal(apoResult.errors.length, 0, 'APO generate should have no errors');

    const apoOrders = await pool.query(
      `SELECT id, order_id, sl_no, employee_id, employee_name, order_docx,
              octet_length(order_docx) AS docx_size
         FROM apo_training_orders
        ORDER BY sl_no`
    );
    assert.equal(apoOrders.rows.length, apoResult.generated, 'APO order rows should match generated count');
    for (const o of apoOrders.rows) {
      assert.ok(o.order_docx, `APO order ${o.order_id} must have order_docx`);
      assert.ok(isDocx(o.order_docx), `APO order ${o.order_id} order_docx must be a valid DOCX`);
    }
  } finally {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await cleanupAll(c);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
});

test('downloadTrainingOrder returns valid DOCX for a stored order', async (t) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await cleanupAll(client);
    await seedGroup(client, 'PO', 'Kakinada', 2);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  try {
    const poResult = await generateOrders({ group: 'PO', createdBy: null });
    assert.ok(poResult.generated > 0);

    const orders = await pool.query(
      `SELECT id, order_id, order_docx FROM po_training_orders ORDER BY sl_no LIMIT 1`
    );
    assert.equal(orders.rows.length, 1);

    const dl = await downloadTrainingOrder('PO', orders.rows[0].id);
    assert.ok(dl.buffer, 'download should return a buffer');
    assert.ok(isDocx(dl.buffer), 'downloaded PO order must be a valid DOCX');
    assert.equal(dl.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.ok(dl.filename.endsWith('.docx'), 'filename should end in .docx');
    assert.equal(dl.buffer.length, orders.rows[0].order_docx.length, 'downloaded buffer should match stored order_docx');
  } finally {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await cleanupAll(c);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
});

test('buildOrdersZip returns valid ZIP with all stored orders', async (t) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await cleanupAll(client);
    await seedGroup(client, 'PO', 'Kakinada', 2);
    await seedGroup(client, 'APO', 'Kakinada', 2);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  try {
    await generateOrders({ group: 'PO', createdBy: null });
    await generateOrders({ group: 'APO', createdBy: null });

    const poZip = await buildOrdersZip('PO');
    assert.ok(isZip(poZip.buffer), 'PO ZIP must be a valid ZIP');
    assert.equal(poZip.count, 2, 'PO ZIP should contain 2 orders');
    assert.ok(poZip.filename.endsWith('.zip'));

    const apoZip = await buildOrdersZip('APO');
    assert.ok(isZip(apoZip.buffer), 'APO ZIP must be a valid ZIP');
    assert.equal(apoZip.count, 2, 'APO ZIP should contain 2 orders');

    const allZip = await buildOrdersZip(null);
    assert.ok(isZip(allZip.buffer), 'ALL ZIP must be a valid ZIP');
    assert.equal(allZip.count, 4, 'ALL ZIP should contain 4 orders (PO + APO)');

    const zip = new PizZip(allZip.buffer);
    let docxCount = 0;
    for (const name of Object.keys(zip.files)) {
      if (!name.endsWith('.docx')) continue;
      const entry = zip.file(name);
      assert.ok(entry, `ZIP entry ${name} should be readable`);
      assert.ok(isDocx(entry.asNodeBuffer()), `ZIP entry ${name} should be a valid DOCX`);
      docxCount += 1;
    }
    assert.equal(docxCount, 4, 'ALL ZIP should contain 4 DOCX entries');
  } finally {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await cleanupAll(c);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
});

test('built-in templates are real .docx files', () => {
  assert.ok(fs.existsSync(PO_TEMPLATE), 'po-order-tagged.docx must exist');
  assert.ok(fs.existsSync(APO_TEMPLATE), 'apo-order-tagged.docx must exist');
  const poBytes = fs.readFileSync(PO_TEMPLATE);
  const apoBytes = fs.readFileSync(APO_TEMPLATE);
  assert.ok(isDocx(poBytes), 'po-order-tagged.docx must be a valid DOCX');
  assert.ok(isDocx(apoBytes), 'apo-order-tagged.docx must be a valid DOCX');
  assert.ok(poBytes.length > 1000, 'PO template should be non-trivial');
  assert.ok(apoBytes.length > 1000, 'APO template should be non-trivial');
});

test('downloadTrainingOrder 404 when order_docx is NULL (never generated)', async (t) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await cleanupAll(client);
    await seedGroup(client, 'PO', 'Kakinada', 1);
    // Allow NULL order_docx so we can simulate a never-generated order row.
    await client.query(`ALTER TABLE po_training_orders ALTER COLUMN order_docx DROP NOT NULL`);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  try {
    const batch = await pool.query(
      `SELECT id AS batch_id FROM po_training_batches LIMIT 1`
    );
    const personnel = await pool.query(
      `SELECT id AS personnel_id, employee_id, employee_name FROM personnel LIMIT 1`
    );
    assert.equal(batch.rows.length, 1);
    assert.equal(personnel.rows.length, 1);

    const inserted = await pool.query(
      `INSERT INTO po_training_orders
         (order_id, sl_no, batch_id, personnel_id, employee_id, employee_name, mandal, venue, status, order_docx)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
       RETURNING id, order_id`,
      ['ORD-NULL-001', 1, batch.rows[0].batch_id, personnel.rows[0].personnel_id,
        personnel.rows[0].employee_id, personnel.rows[0].employee_name, 'Kakinada', '', 'draft']
    );
    assert.equal(inserted.rows.length, 1);

    await assert.rejects(
      () => downloadTrainingOrder('PO', inserted.rows[0].id),
      (err) => err.statusCode === 404 && /not been generated/i.test(err.message)
    );
  } finally {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // Cleanup first so no NULL order_docx rows remain, then restore NOT NULL.
      await cleanupAll(c);
      await c.query(`ALTER TABLE po_training_orders ALTER COLUMN order_docx SET NOT NULL`);
      await c.query('COMMIT');
    } catch (e) {
      // best-effort restore; the NOT NULL must come back even if cleanup fails
      try { await c.query(`ALTER TABLE po_training_orders ALTER COLUMN order_docx SET NOT NULL`); } catch (_) {}
      await c.query('COMMIT').catch(() => {});
    } finally {
      c.release();
    }
  }
});
