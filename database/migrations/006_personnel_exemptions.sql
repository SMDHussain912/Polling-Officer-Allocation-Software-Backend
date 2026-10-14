-- 006_personnel_exemptions: exemption review workflow for circular
-- p.61(a)(vii) bank postings and p.61(a)(viii) personal exemptions.
--
--   personnel_exemptions: append-only audit trail of every exemption
--   authorization. New statuses land here; read endpoints never expose them.
--   No data is deleted or overwritten.

CREATE TABLE personnel_exemptions (
  id SERIAL PRIMARY KEY,
  personnel_id INTEGER NOT NULL REFERENCES personnel (id),
  employee_id TEXT NOT NULL,
  old_exempt_category TEXT,
  new_exempt_category TEXT NOT NULL,
  reason TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stage 1 reads eligible candidates scoped by district.
CREATE INDEX idx_personnel_district ON personnel (district);
