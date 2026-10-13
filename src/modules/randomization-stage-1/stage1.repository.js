'use strict';

/**
 * Stage 1 — persistence port + in-memory reference implementation.
 *
 * ============================================================================
 * SCOPE NOTE — THE POSTGRESQL IMPLEMENTATION IN THIS FILE IS DORMANT
 * ============================================================================
 * The shared schema for randomization runs does NOT exist yet:
 * `database/migrations/` is empty, docs/DATABASE_DESIGN.md marks run statuses
 * and stage-result shapes as TBD, and the migration naming convention is an
 * open team question (DECISIONS_AND_OPEN_QUESTIONS.md B9). Per the team rules
 * this module does NOT create shared tables on its own. A dormant PG factory
 * with the PROPOSED schema and parameterized SQL is appended at the bottom of
 * this file; it refuses to construct unless explicitly enabled. Nothing here
 * executes SQL by default; tests exercise the in-memory reference below.
 * ============================================================================
 */

const crypto = require('crypto');

const {
  Stage1PersistenceError,
  Stage1ConflictError,
} = require('./stage1.errors');
const { RUN_STATUS, STAGE_NUMBER } = require('./stage1.constants');

/**
 * Repository PORT (the contract the service depends on):
 *  beginTransaction()                 -> Promise<tx>
 *  commitTransaction(tx)              -> Promise<void>
 *  rollbackTransaction(tx)            -> Promise<void>
 *  getElectionConfiguration(tx, id, districtId)   -> Promise<config|null>
 *  hasActiveRun(tx, electionConfigId) -> Promise<boolean>
 *  insertRun(tx, runRecord)           -> Promise<{runId}>
 *  insertResults(tx, runId, entries)  -> Promise<void>
 *  getRun(tx, runId, districtId)      -> Promise<run|null>
 *  listRuns(tx, {electionConfigurationId, districtId, limit, offset})
 *  getResults(tx, runId, districtId)  -> Promise<entries[]>
 * Reads must be district-scoped (see PROPOSED SQL in the dormant factory).
 */

/* -------------------------------------------------------------------------
 * In-memory reference implementation (tests + wiring reference; not durable).
 * ---------------------------------------------------------------------- */

/**
 * @param {object} opts
 * @param {Array} opts.electionConfigurations [{id, districtId, status,
 *   requiredStrength: [{mandalId, requiredCount}]}]
 * @param {Array} opts.personnel  Candidate personnel records
 *   {id, isActive, districtId, mandalId, exemptCategory, ...}
 */
function createInMemoryStage1Repository({
  electionConfigurations = [],
  personnel = [],
} = {}) {
  const runs = [];
  const results = [];

  return {
    async beginTransaction() {
      return { id: crypto.randomUUID(), open: true };
    },
    async commitTransaction(tx) {
      if (!tx || tx.open !== true) {
        throw new Stage1PersistenceError('Transaction is not open.');
      }
      tx.open = false;
    },
    async rollbackTransaction(tx) {
      if (tx) tx.open = false;
    },

    async getElectionConfiguration(_tx, electionConfigurationId, districtId) {
      const cfg = electionConfigurations.find((c) => c.id === electionConfigurationId) || null;
      if (!cfg) return null;
      // District scoping: a configuration outside the caller's district is
      // reported as not found for that district.
      if (districtId !== undefined && cfg.districtId !== districtId) return null;
      return cfg;
    },

    async hasActiveRun(_tx, electionConfigurationId) {
      return runs.some(
        (r) =>
          r.electionConfigurationId === electionConfigurationId &&
          r.stage === STAGE_NUMBER &&
          r.status === RUN_STATUS.COMPLETED
      );
    },

    async getEligibleCandidates(_tx, { districtId, mandalId } = {}) {
      // District/mandal scoping happens here; eligibility rules are applied by
      // the service via the eligibility module (defense in depth).
      return personnel.filter(
        (p) =>
          String(p.districtId) === String(districtId) &&
          (mandalId === undefined || mandalId === null ||
            String(p.mandalId) === String(mandalId))
      );
    },

    async insertRun(tx, runRecord) {
      if (tx && tx.open === false) {
        throw new Stage1PersistenceError('Cannot write inside a closed transaction.');
      }
      // Test hook: __failNextPersist simulates a mid-transaction write failure.
      if (runRecord.__failNextPersist === true) {
        throw new Stage1PersistenceError('Simulated write failure.');
      }
      if (
        runs.some(
          (r) =>
            r.electionConfigurationId === runRecord.electionConfigurationId &&
            r.stage === STAGE_NUMBER &&
            r.status === RUN_STATUS.COMPLETED
        )
      ) {
        throw new Stage1ConflictError(
          'A completed Stage 1 run already exists for this election configuration.'
        );
      }
      const runId = `s1run-${crypto.randomUUID()}`;
      runs.push({ runId, ...runRecord });
      if (tx) tx.__runId = runId;
      return { runId };
    },

    async insertResults(tx, runId, entries) {
      if (!runs.some((r) => r.runId === runId)) {
        throw new Stage1PersistenceError('Run does not exist; cannot attach results.');
      }
      for (const e of entries) {
        results.push({ ...e, runId });
      }
      if (tx) tx.__resultCount = entries.length;
    },

    async getRun(_tx, runId, districtId) {
      const run = runs.find((r) => r.runId === runId) || null;
      if (!run) return null;
      // District scoping (matches the PROPOSED PG SQL WHERE district_id = ...).
      if (districtId !== undefined && String(run.districtId) !== String(districtId)) {
        return null;
      }
      return run;
    },

    async listRuns(_tx, { electionConfigurationId, districtId, limit = 50, offset = 0 } = {}) {
      return runs
        .filter((r) =>
          electionConfigurationId ? r.electionConfigurationId === electionConfigurationId : true
        )
        .filter((r) =>
          districtId === undefined || districtId === null
            ? true
            : String(r.districtId) === String(districtId)
        )
        .slice(offset, offset + limit);
    },

    async getResults(_tx, runId, districtId) {
      const run = runs.find((r) => r.runId === runId) || null;
      if (
        !run ||
        (districtId !== undefined && String(run.districtId) !== String(districtId))
      ) {
        return [];
      }
      return results.filter((e) => e.runId === runId);
    },

    // Test-only helper (not part of the port).
    __state: { runs, results },
  };
}

/* -------------------------------------------------------------------------
 * PostgreSQL implementation — DORMANT. See scope note at top of file.
 *
 * PROPOSED schema objects (for team migration approval; names/cols are
 * proposals, not decisions):
 *   randomization_runs(
 *     run_id uuid PK, election_config_id text NOT NULL,
 *     district_id text NOT NULL,        -- enables district-scoped queries
 *     stage smallint NOT NULL CHECK (stage IN (1,2,3)),
 *     executed_by text NOT NULL, executed_at timestamptz NOT NULL,
 *     status text NOT NULL,             -- running|completed|failed|superseded
 *     target_pool_count integer, selected_count integer,
 *     required_count integer, reserve_count integer)
 *   randomization_stage1_results(
 *     run_id uuid REFERENCES randomization_runs(run_id),
 *     personnel_id text NOT NULL, mandal_id text NOT NULL,
 *     classification text NOT NULL CHECK (classification IN ('required','reserve')),
 *     PRIMARY KEY (run_id, personnel_id))
 * Stage 2 consumes ONLY runs where stage=1 AND status='completed' for the
 * election configuration — the agreed handoff (see stage1README.md).
 * ---------------------------------------------------------------------- */

const PROPOSED_SQL = Object.freeze({
  // Election-configuration table is owned by master-data (shared module).
  getElectionConfiguration: `
    SELECT * FROM election_configurations
    WHERE election_config_id = $1 AND district_id = $2`,
  hasActiveRun: `
    SELECT EXISTS (
      SELECT 1 FROM randomization_runs
      WHERE election_config_id = $1 AND stage = 1 AND status = 'completed'
    )`,
  insertRun: `
    INSERT INTO randomization_runs (
      run_id, election_config_id, district_id, stage, executed_by, executed_at,
      status, target_pool_count, selected_count, required_count, reserve_count
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  insertResults: `
    INSERT INTO randomization_stage1_results (run_id, personnel_id, mandal_id, classification)
    SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[])`,
  getRun: `
    SELECT * FROM randomization_runs WHERE run_id = $1 AND district_id = $2`,
  listRuns: `
    SELECT * FROM randomization_runs
    WHERE stage = 1
      AND ($1::text IS NULL OR election_config_id = $1)
      AND district_id = $2
    ORDER BY executed_at DESC LIMIT $3 OFFSET $4`,
  getResults: `
    SELECT r.personnel_id, r.mandal_id, r.classification
    FROM randomization_stage1_results r
    JOIN randomization_runs run ON run.run_id = r.run_id
    WHERE r.run_id = $1 AND run.district_id = $2`,
  // Personnel/master-data tables are owned by shared modules (Phase 3); the
  // exact table/column names follow the agreed personnel schema when it exists.
  getEligibleCandidates: `
    SELECT * FROM polling_personnel
    WHERE district_id = $1 AND mandal_id = $2 AND is_active = true`,
});

/**
 * createPgStage1Repository({ pool, enable }) — DORMANT factory.
 * Refuses to construct unless explicitly enabled, so nobody can run queries
 * against a schema that has not been approved/migrated.
 */
function createPgStage1Repository({ pool, enable = false } = {}) {
  if (enable !== true) {
    throw new Stage1PersistenceError(
      'PostgreSQL Stage 1 repository is dormant: the shared schema and migration ' +
        'convention are not approved yet (see stage1README.md, "Activation"). ' +
        'Pass { enable: true } only after the migrations exist.'
    );
  }
  if (!pool || typeof pool.query !== 'function') {
    throw new Stage1PersistenceError('A pg Pool-like object with query() is required.');
  }
  return {
    async beginTransaction() {
      const client = await pool.connect();
      await client.query('BEGIN');
      return client;
    },
    async commitTransaction(client) {
      try { await client.query('COMMIT'); } finally { client.release(); }
    },
    async rollbackTransaction(client) {
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    },
    async getElectionConfiguration(client, electionConfigurationId, districtId) {
      const { rows } = await client.query(PROPOSED_SQL.getElectionConfiguration, [
        electionConfigurationId, districtId,
      ]);
      return rows[0] || null;
    },
    async hasActiveRun(client, electionConfigurationId) {
      const { rows } = await client.query(PROPOSED_SQL.hasActiveRun, [electionConfigurationId]);
      return rows[0].exists === true;
    },
    async insertRun(client, runRecord) {
      const runId = crypto.randomUUID();
      await client.query(PROPOSED_SQL.insertRun, [
        runId, runRecord.electionConfigurationId, runRecord.districtId,
        runRecord.stage, runRecord.executedBy, runRecord.executedAt,
        runRecord.status, runRecord.targetPoolCount, runRecord.selectedCount,
        runRecord.requiredCount, runRecord.reserveCount,
      ]);
      return { runId };
    },
    async insertResults(client, runId, entries) {
      await client.query(PROPOSED_SQL.insertResults, [
        [runId],
        entries.map((e) => e.personnelId),
        entries.map((e) => e.mandalId),
        entries.map((e) => e.classification),
      ]);
    },
    async getRun(client, runId, districtId) {
      const { rows } = await client.query(PROPOSED_SQL.getRun, [runId, districtId]);
      return rows[0] || null;
    },
    async listRuns(client, { electionConfigurationId = null, districtId, limit = 50, offset = 0 }) {
      const { rows } = await client.query(PROPOSED_SQL.listRuns, [
        electionConfigurationId, districtId, limit, offset,
      ]);
      return rows;
    },
    async getResults(client, runId, districtId) {
      const { rows } = await client.query(PROPOSED_SQL.getResults, [runId, districtId]);
      return rows;
    },
    async getEligibleCandidates(client, { districtId, mandalId } = {}) {
      const { rows } = await client.query(PROPOSED_SQL.getEligibleCandidates, [
        districtId,
        mandalId,
      ]);
      return rows;
    },
  };
}

module.exports = {
  createInMemoryStage1Repository,
  createPgStage1Repository,
  PROPOSED_SQL,
};

