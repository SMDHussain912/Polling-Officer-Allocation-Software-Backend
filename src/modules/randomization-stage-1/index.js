'use strict';

/**
 * Randomization Stage 1 — module entry point (owned by Teammate 1).
 *
 * Exports the module's public surface. The shared app (src/app.js) is an empty
 * placeholder owned jointly; this module does NOT wire itself into it. When
 * the shared app, auth middleware, database layer, and migrations exist, the
 * app owner (with Stage 1 owner review) mounts the router as follows:
 *
 *   const { createStage1Service, createStage1Router,
 *           createPgStage1Repository } =
 *     require('./modules/randomization-stage-1');
 *   const service = createStage1Service({
 *     repository: createPgStage1Repository({ pool: dbPool, enable: true }),
 *     audit: auditModule,                       // shared audit interface
 *     config: { roundingRule: '<ratified rule>' },
 *   });
 *   app.use('/api/randomization/stage-1',
 *           createStage1Router({ service, authenticate, authorize }));
 *
 * See stage1README.md for the confirmed rules, unresolved questions, the
 * proposed API/schema contracts, and activation steps.
 */

const {
  createStage1Service,
  normalizeRequiredStrength,
  validateResultInvariants,
} = require('./stage1.service');
const {
  createInMemoryStage1Repository,
  createPgStage1Repository,
  PROPOSED_SQL,
} = require('./stage1.repository');
const { createStage1Controller, toErrorResponse } = require('./stage1.controller');
const { createStage1Router } = require('./stage1.routes');
const { calculatePoolSize, splitPool } = require('./stage1.pool');
const { isEligible, filterEligible } = require('./stage1.eligibility');
const { selectRandom } = require('./stage1.selection');
const {
  validateExecuteRunRequest,
  validateRunIdParam,
} = require('./stage1.validator');
const constants = require('./stage1.constants');
const errors = require('./stage1.errors');

module.exports = {
  // Factories
  createStage1Service,
  createStage1Repository: createInMemoryStage1Repository, // reference impl alias
  createInMemoryStage1Repository,
  createPgStage1Repository, // DORMANT until shared schema is approved
  createStage1Controller,
  createStage1Router,
  // Pure logic (also exported for tests)
  calculatePoolSize,
  splitPool,
  isEligible,
  filterEligible,
  selectRandom,
  validateExecuteRunRequest,
  validateRunIdParam,
  normalizeRequiredStrength,
  validateResultInvariants,
  toErrorResponse,
  // Contracts
  constants,
  errors,
  PROPOSED_SQL,
};
