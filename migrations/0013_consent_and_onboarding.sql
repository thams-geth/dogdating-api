-- No legal text is seeded: published documents must be reviewed before use.
CREATE TABLE identity.policy_documents (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('terms','privacy','community','location','marketing')),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 60),
  country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  locale text NOT NULL CHECK (length(locale) BETWEEN 2 AND 35),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 100000),
  content_sha256 text GENERATED ALWAYS AS (encode(digest(body, 'sha256'), 'hex')) STORED,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purpose, country_code, locale, version)
);
CREATE INDEX policy_current_idx ON identity.policy_documents
  (country_code, locale, purpose, published_at DESC) WHERE published_at IS NOT NULL;
CREATE FUNCTION identity.preserve_published_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'Published policy documents are immutable; create a new version' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_immutable BEFORE UPDATE OR DELETE ON identity.policy_documents
  FOR EACH ROW EXECUTE FUNCTION identity.preserve_published_policy();

CREATE TABLE identity.consent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES identity.policy_documents(id),
  action text NOT NULL CHECK (action IN ('accepted','withdrawn')),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_user_idx ON identity.consent_events (user_id,id DESC);
COMMENT ON TABLE identity.consent_events IS 'Append-only through the API. Document snapshot is immutable; account erasure may remove personal consent evidence according to retention policy.';

CREATE TABLE identity.user_preferences (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'pack' CHECK (mode='pack'),
  adult_declared boolean NOT NULL DEFAULT false,
  adult_declared_at timestamptz,
  active_dog_id uuid REFERENCES graph.dogs(id) ON DELETE SET NULL,
  discovery_paused boolean NOT NULL DEFAULT true,
  read_receipts boolean NOT NULL DEFAULT true,
  onboarding_completed_at timestamptz,
  onboarding_rules_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN identity.user_preferences.adult_declared IS 'Self-declaration only. Must never grant is_adult_verified or a verification tier.';
