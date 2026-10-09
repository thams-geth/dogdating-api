CREATE TABLE meetup.extension_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 meetup_id uuid NOT NULL REFERENCES meetup.meetups(id) ON DELETE CASCADE,
 requested_by uuid NOT NULL REFERENCES identity.users(id),
 base_revision integer NOT NULL CHECK(base_revision>0),
 proposed_end timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','declined','expired')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_pending_meetup_extension ON meetup.extension_requests(meetup_id) WHERE state='pending';
CREATE TABLE meetup.reminder_receipts (
 meetup_id uuid PRIMARY KEY REFERENCES meetup.meetups(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
