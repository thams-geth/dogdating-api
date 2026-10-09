CREATE TABLE graph.dog_transfers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dog_id uuid NOT NULL REFERENCES graph.dogs(id),
 source_household_id uuid NOT NULL REFERENCES identity.households(id),target_household_id uuid NOT NULL REFERENCES identity.households(id),
 requested_by uuid NOT NULL REFERENCES identity.users(id),recipient_user_id uuid NOT NULL REFERENCES identity.users(id),
 token_hash text NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','cancelled','expired')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',created_at timestamptz NOT NULL DEFAULT now(),accepted_at timestamptz,
 CHECK(source_household_id<>target_household_id),CHECK(requested_by<>recipient_user_id)
);
CREATE UNIQUE INDEX dog_transfer_pending ON graph.dog_transfers(dog_id) WHERE state='pending';
