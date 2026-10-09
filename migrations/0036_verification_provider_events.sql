CREATE TABLE verify.provider_events (
 provider text NOT NULL CHECK(provider ~ '^[a-z0-9_-]{2,40}$'),
 event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 120),
 request_id uuid NOT NULL REFERENCES verify.verification_requests(id),
 body_hash text NOT NULL CHECK(body_hash ~ '^[a-f0-9]{64}$'),
 outcome text NOT NULL CHECK(outcome IN ('approved','rejected','needs_more_info')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,event_id)
);
CREATE INDEX provider_events_request ON verify.provider_events(request_id,created_at);
