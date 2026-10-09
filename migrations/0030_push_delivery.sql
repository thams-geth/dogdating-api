ALTER TABLE ops.push_jobs ADD COLUMN lease_token uuid,ADD COLUMN lease_until timestamptz;
CREATE TABLE ops.push_delivery_receipts (
 notification_id uuid NOT NULL REFERENCES identity.notifications(id) ON DELETE CASCADE,
 installation_id uuid NOT NULL,delivered_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(notification_id,installation_id)
);
CREATE INDEX push_jobs_due ON ops.push_jobs(available_at) WHERE state IN ('awaiting_provider','pending');
