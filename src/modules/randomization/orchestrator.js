
const stage1Module = require('../randomization-stage-1');
const stage2Module = require('../randomization-stage-2');
const stage3Module = require('../randomization-stage-3');

const { createStage1Service, createInMemoryStage1Repository } = stage1Module;
const { formPollingParties } = stage2Module;
const { createStage3Service } = stage3Module;
const { assignMicroObservers } = require('./micro-observer');

/**
 * Map a DB personnel row (+ its batch department name) into the internal shape
 * used by BOTH Stage 1 (candidate) and Stage 2 (employee). Only non-sensitive
 * fields are read.
 */
function toInternalPersonnel(p, departmentName) {
  const officeId = departmentName && String(departmentName).trim() !== ''
    ? String(departmentName).trim()
    : (p.employee_id && String(p.employee_id).trim() !== '' ? 'dept:unknown' : null);
  return {
    id: String(p.employee_id),            // Stage 1 candidate id (opaque)
    personnelId: String(p.employee_id),   // Stage 2 personnelId (same key)
    name: p.employee_name,
    designation: p.designation,
    isActive: p.is_active === true,
    districtId: p.district,               // Stage 1 scope
    mandalId: p.work_mandal,              // Stage 1 mandal scope + Stage 2 workMandal
    workMandal: p.work_mandal,
    nativeMandal: p.native_mandal,
    gazettedStatus: p.gazetted_status || null,
    exemptCategory: p.exempt_category || null,
    officeId: officeId,
    officeName: officeId,
  };
}

/** Seeded RNG (mulberry32) for reproducible demo runs; omitted → crypto default. */
function makeSeededRandomInt(seed) {
  let s = seed >>> 0;
  return function randomInt(maxExclusive) {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(r * maxExclusive);
  };
}

/** Collect audit events in memory (Stage 1 mandates an audit port). */
function createMemoryAudit(sink) {
  return {
    async record(event) {
      sink.push({ at: new Date().toISOString(), ...event });
    },
  };
}

/**
 * Build Stage 2 employees from Stage 1's selected result entries.
 * `internalById` is a Map keyed by personnelId -> internal personnel (from
 * toInternalPersonnel). seniorityRank + presidingEligible come ONLY from
 * designationRules (authority supplied); a designation with no rule fails
 * closed — never inferred from pay/designation.
 */
function buildEmployees(selectedResults, internalById, designationRules) {
  const missing = [];
  const employees = selectedResults.map(function (r) {
    const p = internalById.get(String(r.personnelId));
    if (!p) {
      throw new Error('Selected personnelId not found in source data: ' + r.personnelId);
    }
    const rule = designationRules[p.designation];
    if (!rule || typeof rule.seniorityRank !== 'number' || typeof rule.presidingEligible !== 'boolean') {
      missing.push(p.designation);
    }
    return {
      personnelId: p.id,
      name: p.name,
      designation: p.designation,
      officeId: p.officeId,
      officeName: p.officeName,
      workMandal: p.workMandal,
      nativeMandal: p.nativeMandal,
      gazettedStatus: p.gazettedStatus,
      mandalId: p.mandalId,
      seniorityRank: rule ? rule.seniorityRank : undefined,
      presidingEligible: rule ? rule.presidingEligible : undefined,
      classification: r.classification, // 'required' | 'reserve' from Stage 1
    };
  });
  if (missing.length > 0) {
    const uniq = Array.from(new Set(missing));
    throw new Error(
      'designationRules is missing seniorityRank/presidingEligible for designation(s): ' +
        uniq.join(', ') + '. Supply them explicitly; they are never inferred.'
    );
  }
  return employees;
}

/** Map DB polling_stations rows to the Stage 3 { stationId, stationCode, mandal } shape. */
function buildStations(stationRows) {
  return stationRows.map(function (s) {
    return { stationId: String(s.station_id), stationCode: s.station_number, mandal: s.mandal };
  });
}

/* -------------------------------------------------------------------------
 * Core chain: Stage 1 -> Stage 2 -> Stage 3 over the existing pure services.
 * No stage logic is rewritten; only data is mapped between their contracts.
 * ------------------------------------------------------------------------- */

/**
 * Execute the full allocation chain in-process.
 *
 * @param {object} input
 * @param {Array}  input.personnelRows   DB personnel rows (non-sensitive read).
 * @param {Array}  input.stationRows     DB polling_stations rows (scoped batch).
 * @param {string} input.departmentName  Import batch department (office grouping).
 * @param {object} input.electionConfiguration
 *        { id, status, requiredStrength: [{mandalId, requiredCount}] } — the
 *        authority supplies required strength; it is never derived.
 * @param {object} input.designationRules
 *        { designation: { seniorityRank, presidingEligible } } — authority
 *        supplied; never inferred from designation/pay.
 * @param {object} [input.officeIdOverrides]
 *        { employeeId: officeId } — optional authority-supplied office/school
 *        grouping for Stage 2's same-office rule. The proforma has NO office
 *        column; without overrides officeId falls back to the import batch's
 *        department name (coarse — Stage 2 may then report it cannot form
 *        complete parties; that is fail-closed, not a bug).
 * @param {string} input.districtId   District scope (Stage 1 actor scope).
 * @param {number|string} input.actorId  Authenticated user id (audit trail).
 * @param {number} [input.seed]  Optional RNG seed for reproducible demos.
 * @returns {Promise<{stage1, stage2, stage3, auditEvents}>}
 */
async function runAllocation(input) {
  const {
    personnelRows, stationRows, departmentName,
    electionConfiguration, designationRules,
    districtId, actorId, seed, officeIdOverrides,
  } = input || {};

  if (!Array.isArray(personnelRows) || personnelRows.length === 0) {
    throw Object.assign(new Error('personnelRows must be a non-empty array.'), { statusCode: 400 });
  }
  if (!Array.isArray(stationRows) || stationRows.length === 0) {
    throw Object.assign(new Error('stationRows must be a non-empty array.'), { statusCode: 400 });
  }
  if (!electionConfiguration || !Array.isArray(electionConfiguration.requiredStrength) ||
      electionConfiguration.requiredStrength.length === 0) {
    throw Object.assign(
      new Error('electionConfiguration with requiredStrength is required (authority supplied).'),
      { statusCode: 400 }
    );
  }
  if (!designationRules || typeof designationRules !== 'object') {
    throw Object.assign(new Error('designationRules is required (authority supplied).'), { statusCode: 400 });
  }
  if (!districtId) {
    throw Object.assign(new Error('districtId is required.'), { statusCode: 400 });
  }

  const auditEvents = [];
  const randomInt = seed !== undefined && seed !== null ? makeSeededRandomInt(seed) : undefined;

  // --- Map DB rows to internal personnel (single mapping for S1 + S2). -----
  const internal = personnelRows.map(function (p) {
    const emp = toInternalPersonnel(p, departmentName);
    const override = officeIdOverrides && officeIdOverrides[p.employee_id];
    if (override) {
      emp.officeId = String(override);
      emp.officeName = String(override);
    }
    return emp;
  });
  const internalById = new Map(internal.map(function (p) { return [p.id, p]; }));

  // --- Stage 1: 120% pool incl. reserves (in-memory repo + mandatory audit).
  const repository = createInMemoryStage1Repository({
    electionConfigurations: [electionConfiguration],
    personnel: internal,
  });
  const audit = createMemoryAudit(auditEvents);
  const stage1Service = createStage1Service({ repository: repository, audit: audit, randomInt: randomInt });

  const stage1 = await stage1Service.executeRun(
    { electionConfigurationId: electionConfiguration.id },
    { id: actorId, districtId: districtId }
  );

  // Results are read via the service's district-scoped read API.
  const runResults = await stage1Service.getRunResults(stage1.runId, { id: actorId, districtId: districtId });
  stage1.results = runResults.results;

  // --- Stage 2: form polling parties from Stage 1's selected results. ------
  // One posting slot PER POLLING STATION (circular: each station gets one
  // party), each carrying that station's mandal. Per the circular nobody may
  // be posted to their own work/native mandal — if a posting mandal overlaps
  // the personnel work/native mandals, Stage 2 fail-closes (NO_PARTY_FORMED),
  // which is correct behaviour, not a bug.
  const postingMandals = stationRows.map(function (s) { return s.mandal; });
  const employees = buildEmployees(runResults.results, internalById, designationRules);
  const stage1Run = {
    runId: stage1.runId,
    stage: 1,
    status: 'completed',
    electionConfigurationId: stage1.electionConfigurationId,
    districtId: stage1.districtId,
    results: runResults.results,
  };
  const stage2 = formPollingParties(
    {
      stage1Run: stage1Run,
      employees: employees,
      options: {
        postingMandals: postingMandals,
        seed: seed !== undefined && seed !== null ? seed : undefined,
        useReserves: 'include', // include reserves so all personnel are available for team formation
      },
    },
    { randomInt: randomInt }
  );

  // --- Micro Observer: one per formed party (NEW requirement). -------------
  // Runs AFTER Stage 2's tested formation engine (untouched). The MO is an
  // additional member; teamSize grows by 1 and operationalSize preserves the
  // PO+Polling-Officer count. Eligibility is authority-supplied via
  // designationRules[...].microObserverEligible (never invented).
  const moPlan = assignMicroObservers({
    parties: stage2.parties,
    pool: internal,
    internalById: internalById,
    designationRules: designationRules,
    randomInt: randomInt,
    required: true,
  });
  // Party view handed to Stage 3 + response: operational parties + their MO.
  const stage2WithMo = Object.assign({}, stage2, {
    parties: moPlan.parties,
    // Merge MO placement failures into Stage 2's own unmet requirements.
    unmetRequirements: (stage2.unmetRequirements || []).concat(moPlan.unmetRequirements),
    microObserversAssigned: moPlan.assignedCount,
  });
  if (moPlan.unmetRequirements.length > 0) {
    // Fail closed: a party missing its Micro Observer is not deployment-ready.
    stage2WithMo.status = 'incomplete';
  }

  // --- Stage 3: map formed teams to polling stations (confidential). -------
  // Only when Stage 2 is fully complete (all MOs placed). An incomplete
  // Stage 2 (e.g. MO placement failed) must NOT be silently mapped.
  let stage3;
  if (stage2WithMo.status === 'completed') {
    const stations = buildStations(stationRows);
    const stage3Service = createStage3Service({ randomInt: randomInt });
    stage3 = stage3Service.executeMapping({ stage2Run: stage2WithMo, pollingStations: stations });
  } else {
    stage3 = {
      status: 'not_run',
      stage: 3,
      reason: 'Stage 2 incomplete (see unmetRequirements); mapping not attempted.',
      unmetRequirements: stage2WithMo.unmetRequirements,
    };
  }

  return { stage1: stage1, stage2: stage2WithMo, stage3: stage3, auditEvents: auditEvents };
}

// Stage 2 -> Stage 3 party formation. Used by tests/embedding; the orchestrator
// keeps its own in-process version of this step.
async function _formPollingParties(input, deps) {
  deps = deps || {};
  const randomInt = deps.randomInt;
  const formation = require('./stage2.formation');
  const stage2 = require('./stage2.service');
  const service = stage2.createStage2Service({ randomInt: randomInt });

  const partySize = PRESIDING_OFFICERS_PER_PARTY + input.options.pollingOfficersPerParty;
  const result = formation.formParties(input.employees, {
    partySize: partySize,
    postings: input.options.postingMandals,
    randomInt: randomInt,
    maxAttempts: 50,
    partiesRequested: input.options.partiesRequested,
  });
  const parties = result.parties.map(function (p, i) {
    const teamCode = formation.buildTeamCode(input.options.teamCodePrefix, input.electionShort, i + 1);
    const postingMandal = p.posting ? String(p.posting.raw) : null;
    const members = p.members.map(function (m, idx) {
      return {
        role: formation.roleForSlot(idx, input.options.pollingOfficersPerParty),
        duty: formation.dutyForSlot(idx, input.options.pollingOfficersPerParty),
        personnelId: m.personnelId, name: m.name, designation: m.designation,
        officeId: m.officeId, officeName: m.officeName,
        workMandal: m.workMandal, nativeMandal: m.nativeMandal,
        gazettedStatus: m.gazettedStatus,
        seniorityRank: m.seniorityRank, classification: m.classification,
      };
    });
    return {
      teamCode: teamCode, postingMandal: postingMandal, members: members,
      teamSize: partySize, shortageParty: input.options.pollingOfficersPerParty === 4,
      shortageReason: input.options.pollingOfficersPerParty === 4 ? input.options.shortageReason : null,
      presidingDutyNeedsConfirmation: duties.PRESIDING_DUTY_NEEDS_CONFIRMATION,
    };
  });
  service.verifyInvariants(input.employees, parties, partySize);
  return { parties: parties };
}

module.exports = { runAllocation, buildEmployees, buildStations, _formPollingParties };


