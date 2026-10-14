'use strict';

/**
 * Stage 2 — team-level 20% substitutes (team decision 2026-10-14).
 * Each formed team of size N gets ceil(N x 20%) substitutes from the
 * leftover pool (e.g. 6 -> 2, 5 -> 1). Shortfall is reported, never silent.
 *
 * Run: node --test tests/randomization/stage2-substitutes.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { formPollingParties } = require('../../src/modules/randomization-stage-2');

function employee(i, office, opts) {
  const id = 'EMP-' + String(i).padStart(3, '0');
  const isPO = i === 1;
  return Object.assign(
    {
      personnelId: id,
      personnelKey: id,
      name: 'Officer ' + i,
      designation: isPO ? 'Senior Assistant' : 'Junior Assistant',
      officeId: office,
      officeName: office,
      officeKey: office,
      workMandal: 'W-' + (i % 7),
      nativeMandal: 'N-' + (i % 11),
      seniorityRank: isPO ? 1 : 10 + i,
      presidingEligible: isPO,
      classification: 'required',
    },
    opts || {}
  );
}

function stage1Run() {
  return {
    runId: 's1-sub-test',
    electionConfigurationId: 'ec-sub-2026',
    districtId: 'D1',
    stage: 1,
    status: 'completed',
  };
}

test('team of 6 gets ceil(6x20%)=2 substitutes from leftover', () => {
  // 6 for the team + 2 leftover for substitutes; distinct offices/mandals.
  const employees = [];
  employees.push(employee(1, 'OFF-PO', { seniorityRank: 1, presidingEligible: true }));
  for (let i = 2; i <= 8; i += 1) {
    employees.push(employee(i, 'OFF-' + i));
  }
  const out = formPollingParties(
    {
      stage1Run: stage1Run(),
      employees: employees,
      options: { partiesRequested: 1, postingMandals: ['M-POST'] },
    },
    { randomInt: () => 0 }
  );
  assert.equal(out.parties.length, 1);
  const party = out.parties[0];
  assert.equal(party.members.length, 6);
  assert.equal(party.substitutesRequired, 2);
  assert.equal(party.substitutes.length, 2);
  assert.equal(out.substituteCount, 2);
  // Substitutes are consumed: not double-counted in unassigned.
  const subIds = party.substitutes.map((s) => s.personnelId);
  const unIds = out.unassigned.map((u) => u.personnelId);
  for (const id of subIds) {
    assert.ok(!unIds.includes(id), 'substitute ' + id + ' must not be in unassigned');
    assert.equal(out.parties[0].substitutes.find((s) => s.personnelId === id).substituteFor, party.teamCode);
  }
});

test('substitute shortfall forces INCOMPLETE with SUBSTITUTES_SHORT', () => {
  // Exactly 6 employees: team forms, zero leftover for substitutes.
  const employees = [];
  employees.push(employee(1, 'OFF-PO', { seniorityRank: 1, presidingEligible: true }));
  for (let i = 2; i <= 6; i += 1) {
    employees.push(employee(i, 'OFF-' + i));
  }
  const out = formPollingParties(
    {
      stage1Run: stage1Run(),
      employees: employees,
      options: { partiesRequested: 1, postingMandals: ['M-POST'] },
    },
    { randomInt: () => 0 }
  );
  assert.equal(out.parties.length, 1);
  assert.equal(out.parties[0].substitutes.length, 0);
  assert.equal(out.status, 'incomplete');
  assert.ok(
    out.unmetRequirements.some((r) => r.code === 'SUBSTITUTES_SHORT'),
    'shortfall must be reported, got: ' + JSON.stringify(out.unmetRequirements)
  );
});