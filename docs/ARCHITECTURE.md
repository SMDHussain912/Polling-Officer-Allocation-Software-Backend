# Architecture

> Documentation only. This document describes the intended architecture. No source code, SQL, or configuration has been implemented yet.

## 1. Overview

The backend is a Node.js application that exposes an HTTP API consumed by the frontend used by the District Election Authority and authorized district staff. It stores everything in a single PostgreSQL database shared by all modules, reads personnel and master data from Excel/CSV imports, executes the three randomization stages in order, tracks the subsequent training workflow, and produces reports backed by an audit trail.

Design goals:

- **Stage independence** — the three randomization stages live in separate modules so three developers can work in parallel.
- **One shared contract** — all stages share the same personnel identifiers, election configuration, team records, and database conventions.
- **Traceability** — every significant action is recorded through the audit module.
- **Documentation-first** — this phase defines structure only; implementation follows the sequence in `DEVELOPMENT_PLAN.md`.

## 2. Intended layering

The repository is organized in layers (all directories exist; files are empty placeholders):

| Layer | Location | Intended responsibility |
| --- | --- | --- |
| Entry point | `src/index.js`, `src/app.js` | Start the HTTP server and assemble the application (future) |
| Configuration | `src/config/` | Read environment configuration via `dotenv` (future; no values committed) |
| Database access | `src/database/` | Own the shared PostgreSQL connection and query access patterns using `pg` (future) |
| Middleware | `src/middleware/` | Cross-cutting concerns: authentication (JWT), authorization, request validation, error handling (future) |
| Feature modules | `src/modules/*` | One directory per business capability, listed in section 4 |
| Shared | `src/shared/` | Cross-module constants, identifier conventions, and contract definitions agreed by the team (future) |
| Migrations/seed | `database/migrations/`, `database/seeds/` | Schema evolution and reference-data loading (empty; no SQL written) |
| Tests | `tests/` | Automated tests once a framework is chosen (empty) |

## 3. PostgreSQL integration

- **Single database.** All modules read and write one PostgreSQL database so that Stage 2 can consume Stage 1 output, Stage 3 can consume Stage 2 output, and training can reference completed workflow records without duplication.
- **One access layer.** All modules are expected to reach the database through `src/database/` rather than opening their own connections, keeping connection handling and transaction usage consistent.
- **Schema lives in migrations.** The schema will evolve through ordered files in `database/migrations/`; no schema is defined in application code. No migration has been written yet.
- **Shared identifier conventions.** Personnel, election configuration, polling stations, teams, and randomization runs each get one stable identifier used identically across all stages. The exact format and type are open questions (see `DECISIONS_AND_OPEN_QUESTIONS.md`).
- **Environment handling.** Connection settings will come from environment variables loaded via `dotenv`; no environment file containing values has been created.

## 4. Module boundaries

| Module | Responsibility | Owner |
| --- | --- | --- |
| `master-data` | Departments, offices, designations, classifications, polling stations, election configuration | Shared (steward TBD) |
| `personnel` | Polling personnel records and their attributes | Shared (steward TBD) |
| `imports` | Excel/CSV upload, batch records, row-level validation results | Shared (steward TBD) |
| `randomization-stage-1` | Personnel selection and reserve pool (120% including reserves) | Teammate 1 |
| `randomization-stage-2` | Polling-team formation from Stage 1 output | Teammate 2 |
| `randomization-stage-3` | Polling-team-to-polling-station mapping from Stage 2 output | Me |
| `training` | Sessions, scheduling, attendance, completion after all stages | Me |
| `reports` | Outputs for the District Election Authority | Shared (steward TBD) |
| `audit` | Immutable event trail for all modules | Shared (steward TBD) |

Boundary rules:

- A module owns data access for its own records; it does not write directly into another module's records — it consumes that module's outputs through agreed shared records.
- Cross-module interaction follows the conceptual interfaces in `API_CONTRACTS.md`.
- Stage modules must not reach into each other's internals; the handoff is via shared database records (Stage 1 results → Stage 2, Stage 2 results → Stage 3).

## 5. Dependencies between the randomization stages

```
master-data + personnel + imports
            │
            ▼
   Stage 1 (Teammate 1)  ── produces selected pool incl. reserve personnel
            │
            ▼
   Stage 2 (Teammate 2)  ── produces polling teams with members
            │
            ▼
   Stage 3 (Me)          ── produces polling-station assignments
            │
            ▼
   Training (Me)         ── references personnel + completed stage records

   reports   ── reads outputs of every stage (no stage writes into reports)
   audit     ── receives events from every module (no module owns audit data)
```

- Stage 2 is blocked until Stage 1 output exists for the same election configuration.
- Stage 3 is blocked until Stage 2 output exists for the same election configuration.
- Training references personnel and completed workflow records; it never copies or re-creates them.
- Reports and audit are downstream-only: no randomization stage depends on them.

## 6. Cross-cutting responsibilities

- **Authentication/authorization:** JWT-based sessions (`jsonwebtoken` is declared). District-scoped access and per-role permissions belong in shared middleware so every module enforces them the same way. The permission model itself is not yet decided.
- **Validation:** input validation for imports and API requests is a shared concern; row-level import validation results are stored by the imports module.
- **Audit:** every module emits audit events (actor, action, target, timestamp) to the audit module.
- **Confidentiality:** personnel data is sensitive; access must be limited to authorized district users and recorded in the audit trail.

## 7. Explicit non-goals of this phase

This document intentionally contains no source code, no SQL, no route definitions, no algorithms, and no environment values. All of that is deferred until the team approves the architecture and contracts.

