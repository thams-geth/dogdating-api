-- Additive changes for the Express authentication module.
ALTER TABLE identity.users ADD COLUMN country_code char(2) NOT NULL DEFAULT 'IN'
  CHECK (country_code ~ '^[A-Z]{2}$');
ALTER TABLE identity.otp_challenges ADD COLUMN country_code char(2) NOT NULL DEFAULT 'IN'
  CHECK (country_code ~ '^[A-Z]{2}$');
ALTER TABLE identity.otp_challenges ADD COLUMN delivered_at timestamptz;
COMMENT ON COLUMN identity.sessions.refresh_hash IS
  'Express auth: hmac-sha256:<hex> of a random 256-bit refresh secret. Legacy hashes must be explicitly migrated before accepting legacy sessions.';
COMMENT ON COLUMN identity.users.country_code IS
  'Account enrollment market; distinct from phone calling code and storage residency_region.';
