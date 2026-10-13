# Randomization Stage 1 — Module Documentation

Owner: Teammate 1 (`src/modules/randomization-stage-1/`). This file is module-local; it does not modify any shared document.

---

## 1. What this module does

Executes the **first level of randomization** of polling personnel: from the district manpower database it randomly selects, **for each Mandal**, a pool of **120% of the required strength (including reserves)**, persists the run and its entries atomically, records an audit event, and exposes the completed run to Stage 2 through a database contract.

Workflow: validate request → authorize district scope → validate prerequisites → compute per-Mandal pool sizes → fetch eligible candidates → random distinct selection → classify required vs reserve → verify invariants → persist transactionally → audit → respond.

## 2. Official rules implemented (source: APSEC Circular No.12/USEC/2026, 27.03.2026, with Annexure-III)

| Rule | Source | Where |
|---|---|---|
| Pool = **120% of required number of polling personnel for each Mandal**, generated randomly from the district database; this is the first stage of randomization | Circular p.5, Randomization (b) | `stage1.pool.js`, `stage1.service.js` |
| The 20% excess exists **to keep personnel in reserve** (so reserve = pool − requirement) | Circular p.3(a) | `stage1.pool.js splitPool` |
| Randomization must be performed by software; list drawn from the **updated district manpower database** | Circular p.5(a),(b) | `stage1.selection.js`, repository port |
| All gazetted/non-gazetted Govt servants are drafted by default; exemptions only as listed | Circular p.3(b), p.4 "Exempted" | `stage1.eligibility.js`, `stage1.constants.js EXEMPT_CATEGORY` |
| Districts use their own personnel (district scoping) | Circular p.3(c) | service + repository scoping |
| Personnel record attribute set (name, gender, mobile, designation, office, department, residence, work place, native Mandal, AC) | Circular p.3(d) | `REQUIRED_PERSONNEL_ATTRIBUTES` (declared; enforcement waits on the Phase-3 personnel schema) |
| Per polling station: 1 Presiding Officer + 5 Polling Officers (shortage: 1+4) | Circular p.2 | `PER_POLLING_STATION` (informational; required-strength figures come from the election configuration) |

**Explicitly NOT applied at Stage 1** (they are Stage 2 party-formation rules): proper mixing of offices/departments, pay-scale classification of PO vs Polling Officers, native-Mandal/work-Mandal posting prohibition, female-officer-per-station placement (all under circular p.4 "Proper Mixing…" and Annexure-III).

## 3. Unresolved rules — the module fails closed, never guesses

| ID | Question | Behavior today |
|---|---|---|
| **U1** | Rounding when 120% is not a whole number — the circular is silent | `calculatePoolSize` **throws `Stage1UnresolvedRuleError` unless a rounding rule is supplied**. A `ceil` proposal (pool never below 120%) is available but only via explicit opt-in (`proposedDefaults` or `config.roundingRule`); responses then carry `roundingRuleIsProposed: true`. **Team must ratify or replace it.** |
| **U2** | Are reserves ranked? Replacement/top-up procedure? | Not implemented. Entries carry only `required`/`reserve` classification. No rank, no substitution API. |
| **U3** | May a completed run be re-run/superseded? | A second execution for the same election configuration is **rejected with 409 Conflict** (proposed: prior runs immutable). Team to confirm. |
| **U4** | Does the native-Mandal/work-Mandal prohibition filter the Stage 1 pool or only Stage 2 teams? | Not filtered at Stage 1 (the circular states it under party formation). Team to confirm. |
| — | Random seed / prescribed algorithm / reproducibility | The circular prescribes **no** algorithm or seed. Selection is an unbiased Fisher–Yates shuffle over `crypto.randomInt`. No official-reproducibility claim is made. |

## 4. API contract (PROPOSED — paths are a Phase-2 team decision)

| Method & path | Permission (proposed) | Purpose |
|---|---|---|
| `POST /api/randomization/stage-1/runs` | `stage1.execute` | Execute Stage 1. Body: `{ "electionConfigurationId": string, "roundingRule"?: "ceil"\|"floor"\|"nearest" }`. **201** → run summary. District comes from the authenticated user, never from the body. |
| `GET /api/randomization/stage-1/runs` | `stage1.view` | List run summaries (`?electionConfigurationId=&limit=&offset=`). |
| `GET /api/randomization/stage-1/runs/:runId` | `stage1.view` | Run summary: runId, electionConfigurationId, districtId, stage, status, counts, executedBy/At. |
| `GET /api/randomization/stage-1/runs/:runId/results` | `stage1.viewResults` | Personnel-level results (personnelId, mandalId, classification). Stricter permission — personnel data is confidential. |

Error responses (proposed shape, from `toErrorResponse`): `{ "error": { "code", "message", "details"? } }` with statuses 400/403/404/409/422/500. SQL errors, stacks, and tokens are never returned (test-covered).

The router factory **requires** `authenticate` and `authorize` to be injected and throws otherwise — endpoints can never be mounted unauthenticated.

## 5. Stage 1 → Stage 2 data contract

Stage 2 consumes Stage 1 **only** through shared records (test-pinned in `tests/stage1/contract.test.js`):

- a run row: `electionConfigurationId`, `districtId`, `stage = 1`, `status = 'completed'`, `runId`, executedBy/At, target/selected/required/reserve counts;
- result entries: `runId`, `personnelId` (shared personnel identifier), `mandalId`, `classification ∈ {required, reserve}`.

Stage 1 never writes Stage 2/3 records and Stage 2 must never re-select personnel.

## 6. Database status — DORMANT PG implementation, no migrations created

`database/migrations/` is empty and the schema/naming convention is an unagreed team question (DECISIONS_AND_OPEN_QUESTIONS.md B9), so **this module created no migrations and executes no SQL by default**. `stage1.repository.js` contains:

- an **in-memory reference repository** (used by all tests and as the wiring reference), and
- a **dormant PostgreSQL factory** `createPgStage1Repository({ pool, enable: true })` documenting the proposed schema (`randomization_runs`, `randomization_stage1_results` — see comments in the file) and parameterized SQL; it refuses to construct until explicitly enabled after migrations exist.

### Activation steps (require team approval)

1. Ratify table/column names and the migration prefix (B9) → write the migration in `database/migrations/`.
2. Implement/confirm the shared election-configuration and personnel read interfaces (Phase 3); map their row shapes to `getElectionConfiguration`/`getEligibleCandidates`.
3. Wire in the shared app: `createStage1Service({ repository: createPgStage1Repository({ pool, enable: true }), audit: <shared audit>, config: { roundingRule: '<ratified>' } })` and mount `createStage1Router({ service, authenticate, authorize })` (see `index.js` header).
4. Reconcile the proposed statuses (`executableStatuses`, run statuses) with the ratified schema enums.

## 7. Tests — how to run

No test framework dependency is needed: Node's built-in test runner (zero packages; `package.json` unchanged).

```bash
node --test "tests/stage1/*.test.js"
```

Result at delivery: **59/59 pass** (pool, eligibility, selection, service, reads, http, contract).

Not runnable yet, reported honestly: real HTTP/JWT end-to-end tests (no shared app/auth middleware exist), and integration tests against a real PostgreSQL database (no PostgreSQL installed on this machine; no schema exists). Rollback/atomicity behavior is covered against the in-memory repository's transaction semantics.

## 8. Files

| File | Role |
|---|---|
| `index.js` | Module exports + wiring instructions |
| `stage1.routes.js` | Proposed endpoints; auth fail-closed factory |
| `stage1.controller.js` | Thin HTTP handlers + safe error mapping |
| `stage1.service.js` | Orchestration, prerequisites, atomic persist, audit |
| `stage1.repository.js` | Port + in-memory reference + dormant PG (proposed SQL) |
| `stage1.validator.js` | Request validation |
| `stage1.pool.js` | 120% calculation (U1 fail-closed) + required/reserve split |
| `stage1.eligibility.js` | Confirmed eligibility predicates |
| `stage1.selection.js` | Unbiased Fisher–Yates selection (injectable RNG) |
| `stage1.constants.js` | Official/proposed/open constants with sources |
| `stage1.errors.js` | Typed errors with safe codes/statuses |

