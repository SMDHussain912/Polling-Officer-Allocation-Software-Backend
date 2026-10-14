'use strict';

/**
 * Orchestrator chain test — Stage 1 -> Stage 2 -> Stage 3 in-process.
 * Pure in-memory (no database, no HTTP). Run:
 *   node --test tests/randomization/orchestrator.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAllocation } = require('../../src/modules/randomization/orchestrator');

function personnel(count, mandal) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      employee_id: 'EMP-' + mandal.slice(0, 3).toUpperCase() + '-' + String(i + 1).padStart(3, '0'),
      employee_name: 'Officer ' + mandal + ' ' + (i + 1),
      designation: i % 4 === 0 ? 'School Assistant' : 'Teacher',
      is_active: true,
      district: 'Kakinada',
      work_mandal: mandal,
      native_mandal: 'Anaparthi',
      exempt_category: null,
    });
  }
  return rows;
}

function stations(count, mandal) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      station_id: 'ST-' + mandal.slice(0, 3).toUpperCase() + '-' + String(i + 1).padStart(3, '0'),
      station_number: String(100 + i),
      mandal: mandal,
    });
  }
  return rows;
}

const designationRules = {
  // Lower rank = more senior. PO must be strictly more senior than officers.
  'School Assistant': { seniorityRank: 1, presidingEligible: true, microObserverEligible: true },
  Teacher: { seniorityRank: 5, presidingEligible: false, microObserverEligible: true },
};

function baseInput() {
  const all = [...personnel(18, 'Kakinada'), ...personnel(6, 'Pithapuram')];
  const officeIdOverrides = {};
  all.forEach(function (p, i) {
    officeIdOverrides[p.employee_id] = 'SCHOOL-' + String(i + 1).padStart(2, '0');
  });
  return {
    personnelRows: all,
    stationRows: [...stations(2, 'Tuni'), ...stations(1, 'Mandapeta')], // 3 stations = 3 parties; posting mandals differ from work (Kakinada/Pithapuram) + native (Anaparthi)
    departmentName: 'School Education Dept',
    electionConfiguration: {
      id: 'EC-DEMO-1',
      districtId: 'Kakinada',
      status: 'ready_for_randomization',
      requiredStrength: [
        { mandalId: 'Kakinada', requiredCount: 15 }, // 120% = 18 exactly
        { mandalId: 'Pithapuram', requiredCount: 5 }, // 120% = 6 exactly
      ],
    },
    designationRules: { ...designationRules }, // clone: tests mutate safely
    officeIdOverrides: officeIdOverrides,
    districtId: 'Kakinada',
    actorId: 7,
    seed: 42,
  };
}

test('full chain: Stage 1 -> Stage 2 -> Stage 3 succeeds', async () => {
  const out = await runAllocation(baseInput());

  // Stage 1: 120% pool incl. reserves (15+5 required -> 18+6 pool).
  assert.equal(out.stage1.stage, 1);
  assert.equal(out.stage1.status, 'completed');
  assert.equal(out.stage1.results.length, 24, 'pool = 18 + 6 (120%)');
  const required = out.stage1.results.filter((r) => r.classification === 'required');
  const reserve = out.stage1.results.filter((r) => r.classification === 'reserve');
  assert.equal(required.length, 20, 'required = 15 + 5');
  assert.equal(reserve.length, 4, 'reserve = 20% of required');

  // Stage 2: parties formed from the pool, each with a teamCode.
  assert.equal(out.stage2.stage, 2);
  assert.equal(out.stage2.status, 'completed');
  assert.ok(Array.isArray(out.stage2.parties) && out.stage2.parties.length > 0);
  const codes = new Set(out.stage2.parties.map((p) => p.teamCode));
  assert.equal(codes.size, out.stage2.parties.length, 'teamCodes unique');

  // Micro Observer: exactly one per party, counted in teamSize but flagged
  // separately from the operational (PO + Polling Officers) members.
  const { MICRO_OBSERVER_ROLE } = require('../../src/modules/randomization/micro-observer');
  for (const p of out.stage2.parties) {
    const mos = p.members.filter((m) => m.role === MICRO_OBSERVER_ROLE);
    assert.equal(mos.length, 1, p.teamCode + ' must have exactly one Micro Observer');
    assert.equal(mos[0].isMicroObserver, true, 'MO member is flagged');
    // operationalSize = PO + Polling Officers (excludes MO); teamSize includes MO.
    assert.equal(p.operationalSize, p.members.length - 1, 'operationalSize excludes the MO');
    assert.equal(p.teamSize, p.members.length, 'teamSize includes the MO');
    assert.equal(p.teamSize, p.operationalSize + 1, 'teamSize = operational + 1 MO');
    // MO personnel must not also appear as an operational member.
    const opIds = p.members.filter((m) => !m.isMicroObserver).map((m) => String(m.personnelId));
    assert.ok(!opIds.includes(String(mos[0].personnelId)), 'MO is not double-counted as operational');
  }
  assert.equal(
    out.stage2.microObserversAssigned, out.stage2.parties.length,
    'one MO assigned per party'
  );

  // Stage 3: teams mapped to stations, confidential.
  assert.equal(out.stage3.stage, 3);
  assert.equal(out.stage3.publicationStatus, 'confidential');
  assert.ok(out.stage3.assignments.length > 0);
  assert.deepEqual(
    out.stage3.unmetRequirements, [],
    'equal-or-surplus stations: no unresolved deficits'
  );

  // Audit trail recorded Stage 1 execution.
  assert.ok(out.auditEvents.length > 0, 'audit events recorded');
});

test('fails closed when designationRules lack a used designation', async () => {
  const input = baseInput();
  delete input.designationRules.Teacher;
  await assert.rejects(() => runAllocation(input), /designationRules is missing/);
});

test('fails closed without electionConfiguration.requiredStrength', async () => {
  const input = baseInput();
  input.electionConfiguration = { id: 'EC-X', status: 'ready_for_randomization' };
  await assert.rejects(() => runAllocation(input), /requiredStrength/);
});

test('fails closed with empty personnel', async () => {
  const input = baseInput();
  input.personnelRows = [];
  await assert.rejects(() => runAllocation(input), /personnelRows/);
});

test('fails closed when no Micro Observer is eligible', async () => {
  const input = baseInput();
  // Strip MO eligibility from every designation -> no MO can be placed.
  input.designationRules = {
    'School Assistant': { seniorityRank: 1, presidingEligible: true, microObserverEligible: false },
    Teacher: { seniorityRank: 5, presidingEligible: false, microObserverEligible: false },
  };
  const out = await runAllocation(input);
  // Stage 2 still formed parties, but MO placement failed -> flagged incomplete
  // and reported as an unmet requirement (never silently dropped).
  assert.equal(out.stage2.status, 'incomplete');
  assert.ok(
    out.stage2.unmetRequirements.some((u) => u.code === 'MICRO_OBSERVER_NOT_ASSIGNED'),
    'MO placement failure is reported'
  );
  // Stage 3 must NOT run on an incomplete Stage 2.
  assert.equal(out.stage3.status, 'not_run');
});

test('seeded runs are reproducible', async () => {
  const a = await runAllocation(baseInput());
  const b = await runAllocation(baseInput());
  assert.deepEqual(
    a.stage2.parties.map((p) => p.teamCode),
    b.stage2.parties.map((p) => p.teamCode)
  );
  assert.deepEqual(
    a.stage3.assignments.map((x) => x.teamCode + '@' + x.stationId),
    b.stage3.assignments.map((x) => x.teamCode + '@' + x.stationId)
  );
});
