-- Live ordinals can be rearranged atomically; deleted slots can be reused.
ALTER TABLE graph.dog_media DROP CONSTRAINT dog_media_dog_id_ordinal_key;
CREATE UNIQUE INDEX dog_media_live_ordinal ON graph.dog_media(dog_id, ordinal) WHERE deleted_at IS NULL;

CREATE TABLE graph.media_uploads (
  media_id uuid PRIMARY KEY REFERENCES graph.dog_media(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES identity.users(id),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png')),
  expected_bytes integer NOT NULL CHECK (expected_bytes BETWEEN 1 AND 8388608),
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'awaiting_upload' CHECK (state IN ('awaiting_upload','uploaded','completed','deleted')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  cleanup_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX media_uploads_cleanup ON graph.media_uploads(expires_at) WHERE state IN ('awaiting_upload','uploaded') OR cleanup_required;
