CREATE TABLE ops.maintenance_status (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 run_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('running','completed','failed')),
 started_at timestamptz NOT NULL,
 finished_at timestamptz,
 summary jsonb,
 last_error_code text CHECK(last_error_code IS NULL OR last_error_code='maintenance_failed')
);
