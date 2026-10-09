CREATE TABLE identity.notification_preferences (
 user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
 messages boolean NOT NULL DEFAULT true,
 connections boolean NOT NULL DEFAULT true,
 meetups boolean NOT NULL DEFAULT true,
 push_enabled boolean NOT NULL DEFAULT false,
 timezone text NOT NULL DEFAULT 'Asia/Kolkata',
 quiet_start integer CHECK(quiet_start BETWEEN 0 AND 1439),
 quiet_end integer CHECK(quiet_end BETWEEN 0 AND 1439),
 CHECK((quiet_start IS NULL)=(quiet_end IS NULL))
);
CREATE TABLE identity.devices (
 installation_id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
 family_id uuid NOT NULL,
 platform text NOT NULL CHECK(platform IN ('android','ios','web')),
 provider text NOT NULL CHECK(provider IN ('fcm','apns','webpush')),
 token_hash text NOT NULL UNIQUE,
 token_encrypted bytea NOT NULL,
 locale text NOT NULL,
 app_build integer NOT NULL CHECK(app_build>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
 event_id uuid NOT NULL,
 category text NOT NULL CHECK(category IN ('messages','connections','meetups')),
 conversation_id uuid NOT NULL REFERENCES meetup.conversations(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 read_at timestamptz,
 UNIQUE(user_id,event_id)
);
CREATE TABLE ops.push_jobs (
 notification_id uuid PRIMARY KEY REFERENCES identity.notifications(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'awaiting_provider' CHECK(state IN ('awaiting_provider','pending','delivered','suppressed','dead_letter')),
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 last_error text
);
