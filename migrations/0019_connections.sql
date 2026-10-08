ALTER TABLE meetup.decisions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN requested_by uuid REFERENCES identity.users(id), ADD COLUMN withdrawn_at timestamptz;
CREATE UNIQUE INDEX decisions_id ON meetup.decisions(id);
CREATE TABLE meetup.interest_usage (
 user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
 day date NOT NULL, used integer NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 12), PRIMARY KEY(user_id,day)
);
CREATE TABLE ops.api_receipts (
 user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
 operation text NOT NULL, key uuid NOT NULL, body_hash text NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,operation,key)
);
