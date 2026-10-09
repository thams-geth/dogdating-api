CREATE TABLE ops.staff_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),issuer text NOT NULL,subject text NOT NULL,
 roles text[] NOT NULL CHECK(roles<@ARRAY['moderator','support','appeals','city_ops','operations','reviewer']::text[]),
 active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(issuer,subject)
);
ALTER TABLE safety.reports ADD COLUMN assigned_staff_id uuid REFERENCES ops.staff_accounts(id);
ALTER TABLE safety.enforcement_actions ADD COLUMN decided_by_staff uuid REFERENCES ops.staff_accounts(id),ADD COLUMN previous_user_status identity.user_status;
ALTER TABLE safety.appeals ADD COLUMN decided_by_staff uuid REFERENCES ops.staff_accounts(id);
ALTER TABLE meetup.places ADD COLUMN verified_by_staff uuid REFERENCES ops.staff_accounts(id);
