-- 006_training_po_apo_tables: separate training batch/member tables for PO and APO.
--
-- Training allocation reads Stage 2 output (PO and APO officers) and groups them
-- by each officer's WORK mandal (not duty mandal). PO and APO are stored in
-- separate tables so they can be fetched, checked and trained independently.
-- Micro Observers are excluded from training entirely.
--
-- This migration is additive and safe to re-run (IF NOT EXISTS / DEFAULT).

-- PO training batches
CREATE TABLE IF NOT EXISTS po_training_batches (
  id SERIAL PRIMARY KEY,
  work_mandal TEXT NOT NULL,
  venue TEXT,
  scheduled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'planned', -- planned | held | cancelled
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS po_training_members (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES po_training_batches (id) ON DELETE CASCADE,
  personnel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  designation TEXT,
  work_mandal TEXT NOT NULL,
  native_mandal TEXT NOT NULL,
  gazetted_status TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'PO', -- 'PO'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_training_members_batch ON po_training_members (batch_id);
CREATE INDEX IF NOT EXISTS idx_po_training_members_mandal ON po_training_members (work_mandal);

-- APO training batches
CREATE TABLE IF NOT EXISTS apo_training_batches (
  id SERIAL PRIMARY KEY,
  work_mandal TEXT NOT NULL,
  venue TEXT,
  scheduled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'planned', -- planned | held | cancelled
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS apo_training_members (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES apo_training_batches (id) ON DELETE CASCADE,
  personnel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  designation TEXT,
  work_mandal TEXT NOT NULL,
  native_mandal TEXT NOT NULL,
  gazetted_status TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'APO', -- 'APO'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_apo_training_members_batch ON apo_training_members (batch_id);
CREATE INDEX IF NOT EXISTS idx_apo_training_members_mandal ON apo_training_members (work_mandal);