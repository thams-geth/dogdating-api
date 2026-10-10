-- Staff records are fixture-truncated in tests and may be deprovisioned in operations.
-- Keep the audit actor in ops.audit_log and a historical, nullable staff UUID here.
ALTER TABLE ops.metros DROP CONSTRAINT metros_rollout_updated_by_fkey;
