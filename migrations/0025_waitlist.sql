CREATE TABLE identity.waitlist (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
 metro_id uuid NOT NULL REFERENCES ops.metros(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,metro_id)
);
