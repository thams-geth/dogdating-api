ALTER TABLE graph.dogs ADD COLUMN publication_state text NOT NULL DEFAULT 'draft'
  CHECK (publication_state IN ('draft','published','paused'));
ALTER TABLE graph.dogs ADD COLUMN availability_timezone text NOT NULL DEFAULT 'Asia/Kolkata';
CREATE INDEX dogs_published_idx ON graph.dogs(household_id,id)
  WHERE publication_state='published' AND status='active' AND deleted_at IS NULL;
CREATE TABLE identity.household_invitations (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES identity.households(id) ON DELETE CASCADE,
  invited_by uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  phone_blind_index text NOT NULL CHECK (length(phone_blind_index)=64),
  role identity.household_role NOT NULL CHECK (role <> 'owner'),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash)=64),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  accepted_by uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_household_idx ON identity.household_invitations(household_id) WHERE consumed_at IS NULL;
COMMENT ON TABLE identity.household_invitations IS 'A hashed, expiring token bound to a phone blind index. Creator shares the token manually; no invitation SMS sender is implemented.';
