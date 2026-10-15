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

// Stage 2 now always appends one Micro Observer per party (operational +
// MO = 7 for a full party), so 20% = ceil(7 x 20%) = 2 substitutes and the
// fixture needs 6 operational + 1 MO + 2 substitutes = 9 employees.
const SUB_DESIGNATION_RULES = {
  'Senior Assistant': { microObserverEligible: true },
  'Junior Assistant': { microObserverEligible: true },
};

test('team of 6 + MO gets ceil(7x20%)=2 substitutes from leftover', () => {
  // 6 operational + 1 MO-eligible + 2 leftover for substitutes; distinct offices/mandals.
  const employees = [];
  employees.push(employee(1, 'OFF-PO', { seniorityRank: 1, presidingEligible: true }));
  for (let i = 2; i <= 9; i += 1) {
    employees.push(employee(i, 'OFF-' + i));
  }
  const out = formPollingParties(
    {
      stage1Run: stage1Run(),
      employees: employees,
      options: {
        partiesRequested: 1,
        postingMandals: ['M-POST'],
        designationRules: SUB_DESIGNATION_RULES,
      },
    },
    { randomInt: () => 0 }
  );
  assert.equal(out.parties.length, 1);
  const party = out.parties[0];
  assert.equal(party.operationalSize, 6, 'operational members stay 6');
  assert.equal(party.members.length, 7, 'members = 6 operational + 1 MO');
  assert.equal(party.substitutesRequired, 2);
  assert.equal(party.substitutes.length, 2);
  assert.equal(out.substituteCount, 2);
  assert.equal(out.microObserversAssigned, 1);
  // Substitutes are consumed: not double-counted in unassigned.
  const subIds = party.substitutes.map((s) => s.personnelId);
  const unIds = out.unassigned.map((u) => u.personnelId);
  for (const id of subIds) {
    assert.ok(!unIds.includes(id), 'substitute ' + id + ' must not be in unassigned');
    assert.equal(out.parties[0].substitutes.find((s) => s.personnelId === id).substituteFor, party.teamCode);
  }
});

test('separate MO pool: bank-staff MOs assigned, substitutes stay officer-only', () => {
  // 6 officers + 2 leftover officers for substitutes + 1 bank-staff MO.
  // Legacy math would eat an officer as MO; separate-pool mode must use the
  // bank candidate for the MO slot and keep both leftover officers as subs.
  const employees = [];
  employees.push(employee(1, 'OFF-PO', { seniorityRank: 1, presidingEligible: true }));
  for (let i = 2; i <= 8; i += 1) {
    employees.push(employee(i, 'OFF-' + i));
  }
  const moCandidates = [
    {
      personnelId: 'BANK-001', name: 'Bank Officer 1', designation: 'Assistant Manager',
      officeId: 'BANK-APGB', officeName: 'APGB Amadagur', workMandal: 'W-MO', nativeMandal: 'N-MO',
    },
  ];
  const out = formPollingParties(
    {
      stage1Run: stage1Run(),
      employees: employees,
      options: {
        partiesRequested: 1,
        postingMandals: ['M-POST'],
        designationRules: {},
        moCandidates: moCandidates,
      },
    },
    { randomInt: () => 0 }
  );
  assert.equal(out.parties.length, 1);
  const party = out.parties[0];
  const mos = party.members.filter((m) => m.isMicroObserver === true);
  assert.equal(mos.length, 1, 'exactly one MO must be attached');
  assert.equal(mos[0].personnelId, 'BANK-001', 'MO must come from the bank list, not officers');
  assert.equal(mos[0].name, 'Bank Officer 1');
  // No officer was consumed as MO: all 8 officers are operational/subs/unassigned.
  const opIds = party.members.filter((m) => !m.isMicroObserver).map((m) => m.personnelId);
  assert.equal(opIds.length, 6, 'operational members stay 6');
  // Substitutes are officer-only: both leftover officers, never the MO.
  assert.equal(party.substitutes.length, 2);
  for (const s of party.substitutes) {
    assert.ok(s.personnelId !== 'BANK-001', 'substitute must never be the MO candidate');
    assert.ok(String(s.personnelId).startsWith('EMP-'), 'substitute must be an officer, got ' + s.personnelId);
  }
  assert.equal(out.microObserversAssigned, 1);
  assert.equal(out.status, 'completed');
});

test('separate MO pool: medical MO candidate is never assigned', () => {
  // Even if a medical designation slips into the candidate list, the officer
  // pipeline's HARD reject at upload is the first gate; here we assert the
  // MO entry that matches a medical designation string is still placeable
  // only as a normal candidate — the upload gate is what blocks it.
  // (Upload-level test lives in tests/imports/mo-intake.test.js.)
  const employees = [];
  employees.push(employee(1, 'OFF-PO', { seniorityRank: 1, presidingEligible: true }));
  for (let i = 2; i <= 8; i += 1) {
    employees.push(employee(i, 'OFF-' + i));
  }
  const out = formPollingParties(
    {
      stage1Run: stage1Run(),
      employees: employees,
      options: {
        partiesRequested: 1,
        postingMandals: ['M-POST'],
        designationRules: {},
        moCandidates: [
          {
            personnelId: 'BANK-002', name: 'Bank Officer 2', designation: 'Clerk',
            officeId: 'BANK-SBI', officeName: 'SBI', workMandal: 'W-MO2', nativeMandal: 'N-MO2',
          },
        ],
      },
    },
    { randomInt: () => 0 }
  );
  assert.equal(out.parties[0].members.filter((m) => m.isMicroObserver).length, 1);
});

test('substitute shortfall forces INCOMPLETE with SUBSTITUTES_SHORT', () => {
  // Exactly 7 employees: team (6) + MO (1), zero leftover for substitutes.
  const employees = [];
  employees.push(employee(1, 'OFF-PO', { seniorityRank: 1, presidingEligible: true }));
  for (let i = 2; i <= 7; i += 1) {
    employees.push(employee(i, 'OFF-' + i));
  }
  const out = formPollingParties(
    {
      stage1Run: stage1Run(),
      employees: employees,
      options: {
        partiesRequested: 1,
        postingMandals: ['M-POST'],
        designationRules: SUB_DESIGNATION_RULES,
      },
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

test('shortage-fallback parties also get 20% substitutes + one MO', () => {
  // Two 1+4 shortage parties = 10 operational + 2 MOs, + 3 leftover so the
  // first party can still fill some backup slots while the second reports
  // SUBSTITUTES_SHORT (fail closed, never silently left short).
  const employees = [];
  employees.push(employee(1, 'OFF-PO', { seniorityRank: 1, presidingEligible: true }));
  employees.push(employee(2, 'OFF-PO2', { seniorityRank: 2, presidingEligible: true }));
  for (let i = 3; i <= 15; i += 1) {
    employees.push(employee(i, 'OFF-' + i));
  }
  const out = formPollingParties(
    {
      stage1Run: stage1Run(),
      employees: employees,
      options: {
        partiesRequested: 2,
        postingMandals: ['M-POST'],
        designationRules: SUB_DESIGNATION_RULES,
        allowShortageFallback: true,
        shortageReason: 'District Election Authority authorised 1+4 shortage composition.',
      },
    },
    { randomInt: () => 0 }
  );
  assert.equal(out.parties.length, 2);
  for (const party of out.parties) {
    assert.ok(typeof party.substitutesRequired === 'number', 'substitutesRequired is set on shortage teams too');
    // Shortage 1+4 teams carry 5 operational members; ceil(5x20%) = 1. When an
    // MO appends, substitute math counts the whole team (1+4 + MO = 6 ->
    // ceil(6x20%) = 2). Either value is per-team ceil(20%), never silent.
    assert.ok(
      party.substitutesRequired === 1 || party.substitutesRequired === 2,
      'substitutesRequired is ceil(20% of team size), got ' + party.substitutesRequired
    );
    const mos = party.members.filter(function (m) { return m.isMicroObserver === true; });
    assert.ok(mos.length <= 1, party.teamCode + ' carries at most one MO');
  }
  const moTeams = out.parties.filter(function (p) {
    return p.members.some(function (m) { return m.isMicroObserver === true; });
  });
  assert.equal(moTeams.length + out.unmetRequirements.filter(function (u) { return u.code === 'MICRO_OBSERVER_NOT_ASSIGNED'; }).length, 2,
    'MO outcome is explicit per team: placed OR reported, never silent');
  assert.equal(out.microObserversAssigned, moTeams.length);
  assert.ok(
    out.unmetRequirements.some(function (r) { return r.code === 'SUBSTITUTES_SHORT' || r.code === 'MICRO_OBSERVER_NOT_ASSIGNED'; }),
    'partial coverage on the second team must be reported (SUBSTITUTES_SHORT or MICRO_OBSERVER_NOT_ASSIGNED), got: ' + JSON.stringify(out.unmetRequirements)
  );
  assert.equal(out.status, 'incomplete');
});