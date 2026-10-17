'use strict';

/**
 * Stage 2 — teams contain NO substitutes (substitutes feature removed).
 *
 * Earlier releases appended ceil(teamSize x 20%) substitutes per team and
 * reported SUBSTITUTES_SHORT on shortfall. The feature was removed: a team is
 * exactly its operational officers (6, or 5 for a shortage party) + one
 * Micro Observer, and every leftover officer stays visible in `unassigned`
 * (never silently consumed as a substitute).
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

const SUB_DESIGNATION_RULES = {
  'Senior Assistant': { microObserverEligible: true },
  'Junior Assistant': { microObserverEligible: true },
};

/** Assert a party carries NO substitute fields (feature removed). */
function assertNoSubstitutes(party) {
  assert.equal(party.substitutes, undefined, party.teamCode + ': substitutes array must not exist');
  assert.equal(party.substitutesRequired, undefined, party.teamCode + ': substitutesRequired must not exist');
}

test('team of 6 + MO: no substitutes; leftovers stay visible in unassigned', () => {
  // 9 employees: 6 operational + 1 MO-eligible + 2 leftovers that earlier code
  // would have consumed as 20% substitutes.
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
  assertNoSubstitutes(party);
  assert.equal(party.operationalSize, 6, 'operational members stay 6');
  assert.equal(party.members.length, 7, 'members = 6 operational + 1 MO');
  assert.equal(out.substituteCount, undefined, 'run-level substituteCount removed');
  assert.equal(out.microObserversAssigned, 1);
  // The 2 leftover officers were NOT consumed - they remain unassigned.
  const teamIds = new Set(party.members.map((m) => m.personnelId));
  const leftovers = out.unassigned.map((u) => u.personnelId).filter((id) => !teamIds.has(id));
  assert.equal(leftovers.length, 2, 'both leftover officers stay in unassigned, got ' + leftovers.length);
});

test('separate MO pool: bank-staff MO assigned, no substitute rows', () => {
  // 6 officers + 2 leftover officers + 1 bank-staff MO. Earlier code kept the
  // leftovers as officer-only substitutes; now they simply stay unassigned.
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
        designationRules: SUB_DESIGNATION_RULES,
        moCandidates: [
          { personnelId: 'BANK-001', name: 'Bank MO', designation: 'Clerk', officeId: 'BANK', officeName: 'Bank', workMandal: 'BW', nativeMandal: 'BN' },
        ],
      },
    },
    { randomInt: () => 0 }
  );
  assert.equal(out.parties.length, 1);
  const party = out.parties[0];
  assertNoSubstitutes(party);
  assert.equal(party.members.length, 7, 'members = 6 operational + 1 MO');
  const mo = party.members.find((m) => m.isMicroObserver);
  assert.ok(mo, 'MO assigned');
  assert.equal(mo.personnelId, 'BANK-001', 'MO comes from the bank-staff pool');
  const teamIds = new Set(party.members.map((m) => m.personnelId));
  const leftovers = out.unassigned.map((u) => u.personnelId).filter((id) => !teamIds.has(id));
  assert.equal(leftovers.length, 2, 'leftover officers stay unassigned, got ' + leftovers.length);
  assert.equal(out.microObserversAssigned, 1);
});

test('zero leftover: no SUBSTITUTES_SHORT requirement', () => {
  // Exactly 7 employees: team (6) + MO (1). Earlier code failed this closed
  // with SUBSTITUTES_SHORT; with substitutes removed there is nothing short.
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
  assertNoSubstitutes(out.parties[0]);
  assert.ok(
    !out.unmetRequirements.some((r) => r.code === 'SUBSTITUTES_SHORT'),
    'SUBSTITUTES_SHORT was removed with the substitutes feature, got: ' + JSON.stringify(out.unmetRequirements)
  );
  assert.equal(out.microObserversAssigned, 1);
});

test('shortage-fallback parties: no substitutes, MO outcome explicit', () => {
  // Two 1+4 shortage parties = 10 operational + 2 MOs from 15 employees; the
  // 3 extra officers stay unassigned (earlier code burned them as substitutes).
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
    assertNoSubstitutes(party);
    const mos = party.members.filter(function (m) { return m.isMicroObserver === true; });
    assert.ok(mos.length <= 1, party.teamCode + ' carries at most one MO');
  }
  const moTeams = out.parties.filter(function (p) {
    return p.members.some(function (m) { return m.isMicroObserver === true; });
  });
  assert.equal(
    moTeams.length + out.unmetRequirements.filter(function (u) { return u.code === 'MICRO_OBSERVER_NOT_ASSIGNED'; }).length,
    2,
    'MO outcome is explicit per team: placed OR reported, never silent'
  );
  assert.equal(out.microObserversAssigned, moTeams.length);
  if (out.status === 'incomplete') {
    assert.ok(out.unmetRequirements.length > 0, 'incomplete status must carry unmetRequirements');
    assert.ok(
      !out.unmetRequirements.some((r) => r.code === 'SUBSTITUTES_SHORT'),
      'SUBSTITUTES_SHORT was removed with the substitutes feature'
    );
  }
});
