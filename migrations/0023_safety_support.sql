ALTER TABLE safety.reports ADD COLUMN narrative_encrypted bytea;
ALTER TABLE safety.appeals ADD COLUMN statement_encrypted bytea;
CREATE UNIQUE INDEX appeals_one_per_action_user ON safety.appeals(action_id,user_id);
CREATE TABLE safety.support_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES identity.users(id),
 category text NOT NULL CHECK(category IN ('account','technical','privacy','safety','other')),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','in_review','resolved')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE safety.support_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ticket_id uuid NOT NULL REFERENCES safety.support_tickets(id) ON DELETE CASCADE,
 author_user_id uuid REFERENCES identity.users(id),body_encrypted bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.privacy_tokens (
 token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE identity.otp_challenges ADD COLUMN purpose text NOT NULL DEFAULT 'auth' CHECK(purpose IN ('auth','privacy'));
CREATE TABLE identity.privacy_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES identity.users(id),
 kind text NOT NULL CHECK(kind IN ('export','deletion')),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','ready','completed','failed','needs_review')),
 status_token_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 result_encrypted bytea,expires_at timestamptz,error_code text
);
CREATE UNIQUE INDEX privacy_request_open ON identity.privacy_requests(user_id,kind) WHERE state IN ('queued','processing','needs_review');
