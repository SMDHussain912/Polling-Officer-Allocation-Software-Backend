'use strict';
/** Live verification of near-mandal rules (Stage 2 + Stage 3). One run. */
const pool = require('../src/database');
const { runAllocation } = require('../src/modules/randomization/orchestrator');
const { recordRun } = require('../src/modules/randomization/allocation-store');
const { registerElectionConfiguration } = require('../src/modules/randomization-stage-1/wiring');

async function main() {
  const stations = (await pool.query(
    "SELECT station_id, station_number, mandal FROM polling_stations WHERE import_batch_id = 60 LIMIT 5000"
  )).rows;
  const personnel = (await pool.query(
    'SELECT employee_id, employee_name, designation, is_active, district, work_mandal, native_mandal, exempt_category, import_batch_id FROM personnel WHERE import_batch_id IN (59,61) LIMIT 5000'
  )).rows;
  const dept = await pool.query("SELECT department_name FROM import_batches WHERE id = 59");
  const adj = (await pool.query('SELECT mandal_name, near_mandal_names FROM mandal_adjacency LIMIT 2000')).rows;
  const moRows = (await pool.query(
    'SELECT employee_id, employee_name, designation, bank_name, working_mandal, native_mandal, residence_mandal FROM micro_observers LIMIT 5000'
  )).rows;

  // Per-officer office overrides (distinct-office rule needs real offices).
  const officeIdOverrides = {};
  for (const p of personnel) officeIdOverrides[p.employee_id] = 'OFF-' + p.employee_id;

  // Designation rules: seniority by designation order; PO-eligible for the
  // clerical/administrative cadre; MO-eligible none (separate MO upload used).
  const designations = [...new Set(personnel.map((p) => p.designation))];
  const designationRules = {};
  designations.forEach((d, i) => {
    const po = /superintendent|administrative|junior assistant|record assistant|office/i.test(d);
    designationRules[d] = { seniorityRank: i + 1, presidingEligible: po, microObserverEligible: false };
  });

  // requiredStrength: keyed on personnel WORK mandals (Stage 1 pool scope).
  // 15 per mandal x 6 mandals = 90 selected (pool needs 120% -> 18 <= 28 each).
  const byMandal = {};
  for (const p of personnel) byMandal[p.work_mandal] = (byMandal[p.work_mandal] || 0) + 1;
  const requiredStrength = Object.entries(byMandal).map(([mandalId]) => ({ mandalId, requiredCount: 10 }));

  registerElectionConfiguration({ id: 'EC-LIVE-NEAR', districtId: 'Kakinada', status: 'ready_for_randomization', requiredStrength });
  const result = await runAllocation({
    personnelRows: personnel,
    stationRows: stations,
    departmentName: (dept.rows[0] || {}).department_name || 'Dept',
    officeIdOverrides,
    electionConfiguration: { id: 'EC-LIVE-NEAR', districtId: 'Kakinada', status: 'ready_for_randomization', requiredStrength },
    designationRules,
    districtId: 'Kakinada',
    actorId: 3,
    moRows,
    mandalAdjacencyRows: adj,
  });

  console.log('adjacency rows:', adj.length);
  console.log('stage2 status:', result.stage2.status);
  console.log('parties:', (result.stage2.parties || []).length,
    'unassigned:', (result.stage2.unassigned || []).length);
  const s2unmet = result.stage2.unmetRequirements || [];
  console.log('stage2 unmet:', JSON.stringify(s2unmet.map((u) => ({ code: u.code, count: u.count }))));
  console.log('stage3 status:', result.stage3.status, 'assignments:', (result.stage3.assignments || []).length);
  console.log('stage3 unmet:', JSON.stringify((result.stage3.unmetRequirements || []).map((u) => ({ code: u.code, count: u.count }))));

  // --- Verify rule: every posting mandal ∈ near(work)∩near(native) of members.
  const lookupRows = adj;
  const near = new Map(lookupRows.map((r) => [r.mandal_name.toLowerCase(), (r.near_mandal_names || []).map((n) => n.toLowerCase())]));
  const person = new Map(personnel.map((p) => [p.employee_id, p]));
  let badPostings = 0;
  let checked = 0;
  for (const party of result.stage2.parties || []) {
    for (const m of party.members || []) {
      const per = person.get(String(m.personnelId));
      if (!per) continue;
      checked += 1;
      const w = near.get(String(per.work_mandal).toLowerCase());
      const n = near.get(String(per.native_mandal).toLowerCase());
      const posting = String(party.postingMandal || '').toLowerCase();
      const own = posting === String(per.work_mandal).toLowerCase() || posting === String(per.native_mandal).toLowerCase();
      if (!w || !n || !w.includes(posting) || !n.includes(posting) || own) badPostings += 1;
    }
  }
  console.log('RULE-2 STAGE2 check: members=' + checked + ' violations=' + badPostings);

  // --- Rule 1: distinct office per party.
  let dupOffice = 0;
  for (const party of result.stage2.parties || []) {
    const keys = (party.members || []).map((m) => String(m.officeId).toLowerCase());
    if (new Set(keys).size !== keys.length) dupOffice += 1;
  }
  console.log('RULE-1 check: parties with duplicate office =', dupOffice);

  // --- Stage 3: station mandal near every member.
  let s3bad = 0;
  const partyByCode = new Map((result.stage2.parties || []).map((p) => [p.teamCode, p]));
  for (const a of result.stage3.assignments || []) {
    const party = partyByCode.get(a.teamCode);
    if (!party) continue;
    const stationM = String(a.stationMandal || '').toLowerCase();
    for (const m of party.members || []) {
      const per = person.get(String(m.personnelId));
      if (!per) continue;
      const w = near.get(String(per.work_mandal).toLowerCase());
      const n = near.get(String(per.native_mandal).toLowerCase());
      const own = stationM === String(per.work_mandal).toLowerCase() || stationM === String(per.native_mandal).toLowerCase();
      if (!w || !n || !w.includes(stationM) || !n.includes(stationM) || own) s3bad += 1;
    }
  }
  console.log('RULE-2 STAGE3 check: violations =', s3bad, '/', (result.stage3.assignments || []).length, 'assignments');

  const saved = await recordRun({
    runAt: new Date().toISOString(),
    runBy: { id: 3, username: 'nic', role: 'admin' },
    ...result,
  });
  console.log('saved runId:', saved.id, 'stageTables:', JSON.stringify(saved.stageTables));
  await pool.end();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
