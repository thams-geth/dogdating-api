ALTER TABLE verify.verification_requests
  ADD COLUMN requested_by uuid REFERENCES identity.users(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX verification_request_active_per_requester
  ON verify.verification_requests(requested_by,subject_type,subject_id,target_tier)
  WHERE requested_by IS NOT NULL AND state IN ('pending','in_review','needs_more_info');
ALTER TABLE verify.health_records
  ADD COLUMN created_by uuid REFERENCES identity.users(id),
  ADD COLUMN deleted_at timestamptz;
CREATE INDEX health_records_live ON verify.health_records(dog_id, id) WHERE deleted_at IS NULL;
