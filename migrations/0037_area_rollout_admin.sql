ALTER TABLE ops.metros
  ADD COLUMN rollout_version integer NOT NULL DEFAULT 1 CHECK (rollout_version > 0),
  ADD COLUMN rollout_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN rollout_updated_by uuid REFERENCES ops.staff_accounts(id);
