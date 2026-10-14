'use strict';

/**
 * Stage 1 — application wiring (app-owner integration; no Stage 1 business
 * logic lives here). Implements the mount documented in index.js, adapted to
 * the infrastructure that actually exists:
 *
 *  - Authorization: resolves the Stage 1 router's PROPOSED permission strings
 *    ('stage1.execute', 'stage1.view', 'stage1.viewResults') to the approved
 *    role policy (staff=read, authority/admin=execute) via the shared
 *    authorize() middleware. Unknown permission strings throw at MOUNT time
 *    (fail closed) — same philosophy as the router factory itself.
 *  - Authentication: the shared session middleware (requireAuth) maps
 *    req.session.user -> req.actor for the Stage 1 controller's contract.
 *    District scope is the project's confirmed single-district scope
 *    (Kakinada); it is NEVER taken from the request body.
 *  - Election configurations: authority-supplied only. The orchestrator
 *    route (POST /api/randomization/run) registers the configuration the
 *    authority submitted; POST /stage-1/runs then references it by id.
 *  - Candidates: read live from `personnel` (non-sensitive allow-list,
 *    district/mandal scoped) — same mapping as the orchestrator.
 *  - Runs/results: IN-MEMORY (transient; lost on restart). Durable Stage 1
 *    run tables remain blocked on the teammate-owned migration.
 */

const { requireAuth, authorize } = require('../../middleware/auth');
const pool = require('../../database');
const {
  createStage1Service,
  createStage1Router,
} = require('./index');

/** Confirmed single-district scope (project decision; never from request). */
const DEFAULT_DISTRICT_ID = 'Kakinada';

/* --- Authority-supplied election-configuration registry ------------------ */

const configurationRegistry = new Map();

/**
 * Register an election configuration the authority submitted to the
 * orchestrator route so Stage 1 standalone runs can reference it by id.
 * Pure registration — no derivation, no defaults.
 */
function registerElectionConfiguration(cfg) {
  if (cfg && typeof cfg.id === 'string' && cfg.id.trim() !== '') {
    configurationRegistry.set(cfg.id, cfg);
  }
  return cfg;
}

function getRegisteredConfiguration(id) {
  return configurationRegistry.get(id) || null;
}

/* --- Repository adapter (live personnel reads + in-memory run store) ------ */

function toCandidate(p) {
  return {
    id: String(p.employee_id),
    name: p.employee_name,
    designation: p.designation,
    isActive: p.is_active === true,
    districtId: p.district,
    mandalId: p.work_mandal,
    exemptCategory: p.exempt_category || null,
  };
}

function createAppStage1Repository() {
  const runs = [];
  const results = [];
  const { Stage1ConflictError, Stage1PersistenceError } = require('./stage1.errors');
  const { STAGE_NUMBER, RUN_STATUS } = require('./stage1.constants');

  return {
    async beginTransaction() {
      return { id: 'tx', open: true };
    },
    async commitTransaction(tx) {
      if (!tx || tx.open !== true) throw new Stage1PersistenceError('Transaction is not open.');
      tx.open = false;
    },
    async rollbackTransaction(tx) {
      if (tx) tx.open = false;
    },

    async getElectionConfiguration(_tx, id, districtId) {
      const cfg = getRegisteredConfiguration(id);
      if (!cfg) return null;
      if (districtId !== undefined && cfg.districtId !== undefined &&
          String(cfg.districtId) !== String(districtId)) {
        return null;
      }
      // Stores the authority-supplied object; the Stage 1 service reads
      // cfg.id / cfg.status / cfg.requiredStrength from it.
      return { districtId: districtId, ...cfg };
    },

    async hasActiveRun(_tx, electionConfigurationId) {
      return runs.some(
        (r) => r.electionConfigurationId === electionConfigurationId &&
          r.stage === STAGE_NUMBER && r.status === RUN_STATUS.COMPLETED
      );
    },

    async getEligibleCandidates(_tx, { districtId, mandalId } = {}) {
      // District/mandal scoping AND batch scoping: only the LATEST personnel
      // import batch is authoritative (same default as the orchestrator route).
      // Without this, rows from earlier imports would mix into the pool.
      // Eligibility rules are applied by the service (defense in depth).
      const { rows } = await pool.query(
        'SELECT employee_id, employee_name, designation, is_active, district, ' +
          'work_mandal, native_mandal, exempt_category ' +
          'FROM personnel WHERE district = $1 AND work_mandal = $2 ' +
          'AND import_batch_id = (SELECT max(id) FROM import_batches WHERE kind = $3) ' +
          'LIMIT 5000',
        [districtId, mandalId, 'personnel']
      );
      return rows.map(toCandidate);
    },

    async insertRun(tx, runRecord) {
      if (tx && tx.open === false) throw new Stage1PersistenceError('Cannot write inside a closed transaction.');
      if (runs.some((r) => r.electionConfigurationId === runRecord.electionConfigurationId &&
          r.stage === STAGE_NUMBER && r.status === RUN_STATUS.COMPLETED)) {
        throw new Stage1ConflictError('A completed Stage 1 run already exists for this election configuration.');
      }
      const runId = 's1run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      runs.push({ runId, ...runRecord });
      return { runId };
    },

    async insertResults(tx, runId, entries) {
      if (!runs.some((r) => r.runId === runId)) {
        throw new Stage1PersistenceError('Run does not exist; cannot attach results.');
      }
      for (const e of entries) results.push({ ...e, runId });
    },

    async getRun(_tx, runId, districtId) {
      const run = runs.find((r) => r.runId === runId) || null;
      if (!run) return null;
      if (districtId !== undefined && String(run.districtId) !== String(districtId)) return null;
      return run;
    },

    async listRuns(_tx, { electionConfigurationId, districtId, limit = 50, offset = 0 } = {}) {
      return runs
        .filter((r) => (electionConfigurationId ? r.electionConfigurationId === electionConfigurationId : true))
        .filter((r) => (districtId === undefined || districtId === null ? true : String(r.districtId) === String(districtId)))
        .slice(offset, offset + limit);
    },

    async getResults(_tx, runId, districtId) {
      const run = runs.find((r) => r.runId === runId) || null;
      if (!run || (districtId !== undefined && String(run.districtId) !== String(districtId))) return [];
      return results.filter((e) => e.runId === runId);
    },
  };
}

/* --- Audit port (in-memory; Stage 1 refuses to run unaudited) ------------- */

const auditEvents = [];

function createAppStage1Audit() {
  return {
    async record(event) {
      auditEvents.push({ at: new Date().toISOString(), ...event });
    },
  };
}

/* --- Auth adapters (the permission-string vs role-based resolution) ------- */

function stage1Authenticate(req, res, next) {
  requireAuth(req, res, function () {
    const u = req.session.user;
    req.actor = {
      id: u.id,
      username: u.username,
      role: u.role,
      districtId: DEFAULT_DISTRICT_ID,
    };
    next();
  });
}

const PERMISSION_ROLES = Object.freeze({
  'stage1.execute': ['authority', 'admin'],
  'stage1.view': ['staff', 'authority', 'admin'],
  'stage1.viewResults': ['staff', 'authority', 'admin'],
});

function stage1Authorize(permission) {
  const roles = PERMISSION_ROLES[permission];
  if (!roles) {
    throw new Error('Unknown Stage 1 permission "' + permission + '" — refusing to mount.');
  }
  return authorize(...roles);
}

/* --- Assemble the mounted router ------------------------------------------ */

function createAppStage1Router() {
  const service = createStage1Service({
    repository: createAppStage1Repository(),
    audit: createAppStage1Audit(),
  });
  return createStage1Router({
    service,
    authenticate: stage1Authenticate,
    authorize: stage1Authorize,
  });
}

module.exports = {
  registerElectionConfiguration,
  getRegisteredConfiguration,
  createAppStage1Router,
  stage1Authenticate,
  stage1Authorize,
  DEFAULT_DISTRICT_ID,
};

