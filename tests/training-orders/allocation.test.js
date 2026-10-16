'use strict';

/**
 * tests/training-orders/allocation.test.js
 * Pure + stubbed-pool tests for PO/APO split, MO skip, tagged template merge.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const orderMerge = require('../../src/modules/imports/order-merge.service');
const {
  classifyRole,
  parseTrainingDate,
  allocateTraining,
  buildOrdersZip,
} = require('../../src/modules/training-orders/index');

test('classifyRole: PO / APO / MO', () => {
  assert.equal(classifyRole('Presiding Officer'), 'PO');
  assert.equal(classifyRole('Polling Officer 1'), 'APO');
  assert.equal(classifyRole('Polling Officer 5'), 'APO');
  assert.equal(classifyRole('Micro Observer'), 'MO');
  assert.equal(classifyRole('micro observer (bank)'), 'MO');
});

test('parseTrainingDate supports dd.mm.yyyy', () => {
  const p = parseTrainingDate('20.10.2026');
  assert.equal(p.dd, '20');
  assert.equal(p.mm, '10');
  assert.equal(p.yyyy, '2026');
  assert.ok(p.weekday);
});

test('built-in tagged PO template merges officer + training FROM-TO fields', () => {
  const templatePath = path.join(__dirname, '../../docs/po-order-tagged.docx');
  assert.ok(fs.existsSync(templatePath), 'po-order-tagged.docx must exist');
  const out = orderMerge.mergeDocx(fs.readFileSync(templatePath), {
    sl_no: '7',
    district: 'Kakinada',
    employee_id: 'EMP9',
    employee_name: 'Rama Rao',
    designation_dept: 'Clerk / Revenue',
    office_address: 'Revenue Department',
    mobile_no: '9000000000',
    order_date: '15.10.2026',
    order_place: 'Kakinada',
    election_year: '2026',
    training_dd: '20',
    training_mm: '10',
    training_weekday: 'Tuesday',
    training_time_from: '10:00 AM',
    training_time_to: '01:00 PM',
    training_venue: 'ZPHS Samalkot',
    duty_mandal: 'Samalkot',
    ack_name: 'Rama Rao',
    ack_designation: 'Clerk',
    ack_mobile: '9000000000',
    ack_work_mandal: 'Kakinada Rural',
  });
  const xml = new PizZip(out).file('word/document.xml').asText();
  assert.ok(xml.includes('Rama Rao'));
  assert.ok(xml.includes('10:00 AM'));
  assert.ok(xml.includes('01:00 PM'));
  assert.ok(xml.includes('Samalkot'));
  assert.ok(xml.includes('Kakinada Rural'));
  assert.ok(!xml.includes('{employee_name}'));
  assert.ok(!xml.includes('{{employee_name}}'));
});

test('allocateTraining wipes + splits PO/APO per mandal; skips MO (stubbed pool)', async () => {
  const pool = require('../../src/database');
  const store = require('../../src/modules/randomization/allocation-store');
  // recordRun writes via pool.query (allocation_runs insert) — stub it so the
  // test never touches the live DB. The id it returns scopes the 014 tables.
  const realQuery = pool.query;
  pool.query = async (sql) => {
    if (/INSERT INTO allocation_runs/i.test(String(sql))) {
      return { rows: [{ id: 999, run_at: new Date() }] };
    }
    // cold-start hydrate / stage-table read both return empty -> run JSON path
    if (/FROM allocation_runs|FROM stage2_team_members/i.test(String(sql))) {
      return { rows: [] };
    }
    throw new Error('unexpected pool.query in test: ' + String(sql).slice(0, 100));
  };
  await store.recordRun({
    runAt: new Date().toISOString(),
    runBy: { id: 1, username: 't', role: 'authority' },
    stage1: { status: 'completed' },
    stage2: {
      status: 'completed',
      excelRows: [
        { teamCode: 'T1', mandal: 'M1', role: 'Presiding Officer', employeeId: 'E101', name: 'PO1' },
        { teamCode: 'T1', mandal: 'M1', role: 'Polling Officer 1', employeeId: 'E102', name: 'APO1' },
        { teamCode: 'T1', mandal: 'M1', role: 'Polling Officer 2', employeeId: 'E103', name: 'APO2' },
        { teamCode: 'T1', mandal: 'M1', role: 'Micro Observer', employeeId: 'MO1', name: 'MO1' },
        { teamCode: 'T2', mandal: 'M2', role: 'Presiding Officer', employeeId: 'E104', name: 'PO2' },
      ],
    },
    stage3: { status: 'completed' },
  });

  const personnelByEmp = {
    E101: { id: 1, employee_id: 'E101', employee_name: 'PO1', designation: 'D', mobile_no: null, work_mandal: 'W', residence_address: null, department_name: 'Dept' },
    E102: { id: 2, employee_id: 'E102', employee_name: 'APO1', designation: 'D', mobile_no: null, work_mandal: 'W', residence_address: null, department_name: 'Dept' },
    E103: { id: 3, employee_id: 'E103', employee_name: 'APO2', designation: 'D', mobile_no: null, work_mandal: 'W', residence_address: null, department_name: 'Dept' },
    E104: { id: 4, employee_id: 'E104', employee_name: 'PO2', designation: 'D', mobile_no: null, work_mandal: 'W', residence_address: null, department_name: 'Dept' },
  };

  const realConnect = pool.connect;
  let seq = 500;
  pool.connect = async () => ({
    query: async (sql, params) => {
      const s = String(sql);
      if (/BEGIN|COMMIT|ROLLBACK/i.test(s)) return { rows: [] };
      if (/DELETE FROM (po|apo)_training/i.test(s)) return { rows: [] };
      if (/FROM personnel p/i.test(s) && /employee_id = ANY/i.test(s)) {
        const ids = params[0] || [];
        return { rows: ids.map((id) => personnelByEmp[id]).filter(Boolean) };
      }
      if (/INSERT INTO (po|apo)_training_batches/i.test(s)) {
        return { rows: [{ id: seq++ }] };
      }
      if (/INSERT INTO (po|apo)_training_batch_members/i.test(s)) {
        return { rows: [] };
      }
      throw new Error('unexpected SQL in test: ' + s.slice(0, 120));
    },
    release: async () => {},
  });

  try {
    const result = await allocateTraining({ createdBy: 1 });
    assert.equal(result.errors.length, 0);
    assert.equal(result.skippedMo, 1);
    assert.equal(result.batches.length, 3);
    const groups = result.batches.map((b) => b.group + '/' + b.mandal).sort();
    assert.deepEqual(groups, ['APO/M1', 'PO/M1', 'PO/M2']);
  } finally {
    pool.connect = realConnect;
    pool.query = realQuery;
    store._reset();
  }
});

test('allocateTraining prefers stage tables (014) over run JSON', async () => {
  const pool = require('../../src/database');
  // latestStageTables reads via pool.query — stub a stored run with a
  // pre-classified PO + APO row (MO already excluded at persist time).
  const realQuery = pool.query;
  const stageRows = [
    { run_id: 7, team_code: 'T1', employee_id: 'E201', personnel_id: 11, role: 'Presiding Officer', duty: null, training_group: 'PO', mandal: 'M9', station_id: null, station_code: null, station_mandal: null, publication_status: 'confidential' },
    { run_id: 7, team_code: 'T1', employee_id: 'E202', personnel_id: 12, role: 'Polling Officer 1', duty: null, training_group: 'APO', mandal: 'M9', station_id: null, station_code: null, station_mandal: null, publication_status: 'confidential' },
  ];
  pool.query = async (sql) => {
    const s = String(sql);
    if (/FROM stage2_team_members/i.test(s)) return { rows: stageRows };
    // cold-start hydrate returns no prior run -> falls to stage tables
    if (/FROM allocation_runs/i.test(s)) return { rows: [] };
    throw new Error('unexpected pool.query in test: ' + s.slice(0, 100));
  };

  const personnelByEmp = {
    E201: { id: 11, employee_id: 'E201', employee_name: 'PO9', designation: 'D', mobile_no: null, work_mandal: 'W', residence_address: null, department_name: 'Dept' },
    E202: { id: 12, employee_id: 'E202', employee_name: 'APO9', designation: 'D', mobile_no: null, work_mandal: 'W', residence_address: null, department_name: 'Dept' },
  };
  const realConnect = pool.connect;
  let seq = 700;
  pool.connect = async () => ({
    query: async (sql, params) => {
      const s = String(sql);
      if (/BEGIN|COMMIT|ROLLBACK/i.test(s)) return { rows: [] };
      if (/DELETE FROM (po|apo)_training/i.test(s)) return { rows: [] };
      if (/FROM personnel p/i.test(s) && /employee_id = ANY/i.test(s)) {
        const ids = params[0] || [];
        return { rows: ids.map((id) => personnelByEmp[id]).filter(Boolean) };
      }
      if (/INSERT INTO (po|apo)_training_batches/i.test(s)) return { rows: [{ id: seq++ }] };
      if (/INSERT INTO (po|apo)_training_batch_members/i.test(s)) return { rows: [] };
      throw new Error('unexpected SQL in test: ' + s.slice(0, 120));
    },
    release: async () => {},
  });

  try {
    const result = await allocateTraining({ createdBy: 1 });
    assert.equal(result.errors.length, 0);
    assert.equal(result.source, 'stage_tables');
    assert.equal(result.stageRunId, 7);
    assert.equal(result.skippedMo, 0);
    const groups = result.batches.map((b) => b.group + '/' + b.mandal).sort();
    assert.deepEqual(groups, ['APO/M9', 'PO/M9']);
  } finally {
    pool.connect = realConnect;
    pool.query = realQuery;
  }
});

test('buildOrdersZip 404 when empty (uses live pool query — stub)', async () => {
  const pool = require('../../src/database');
  const realQuery = pool.query;
  pool.query = async () => ({ rows: [] });
  try {
    await assert.rejects(() => buildOrdersZip('PO'), (err) => err.statusCode === 404);
  } finally {
    pool.query = realQuery;
  }
});
