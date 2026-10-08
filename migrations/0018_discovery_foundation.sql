ALTER TABLE graph.dogs ADD COLUMN published_by uuid REFERENCES identity.users(id);
ALTER TABLE graph.match_preferences ADD COLUMN allow_city_only boolean NOT NULL DEFAULT false;

-- A published row alone is insufficient: tie disclosure to a current, consenting publisher.
CREATE VIEW graph.discovery_guardians AS
SELECT u.id,u.display_name,u.country_code,u.locale FROM identity.users u
JOIN identity.user_preferences p ON p.user_id=u.id
WHERE u.status='active' AND u.is_adult_verified AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL
  AND p.adult_declared AND NOT p.discovery_paused
  AND EXISTS (SELECT 1 FROM verify.tiers_granted t WHERE t.subject_type='user' AND t.subject_id=u.id
    AND t.tier>=1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()))
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ('terms'),('privacy'),('community'),('location')) purpose(name)
    LEFT JOIN LATERAL (SELECT d.id FROM identity.policy_documents d WHERE d.purpose=purpose.name
      AND d.country_code=u.country_code AND d.locale=u.locale AND d.published_at<=now()
      ORDER BY d.published_at DESC,d.id DESC LIMIT 1) current_document ON true
    LEFT JOIN LATERAL (SELECT e.document_id,e.action FROM identity.consent_events e
      JOIN identity.policy_documents d ON d.id=e.document_id WHERE e.user_id=u.id AND d.purpose=purpose.name
      ORDER BY e.id DESC LIMIT 1) latest_event ON true
    WHERE current_document.id IS NULL OR latest_event.document_id IS DISTINCT FROM current_document.id
      OR latest_event.action IS DISTINCT FROM 'accepted'
  );

CREATE VIEW graph.discovery_dogs AS
SELECT d.id,d.household_id,d.name,d.sex,d.size_class,d.bio,d.published_by,
  (date_part('year',age(current_date,d.date_of_birth))*12+date_part('month',age(current_date,d.date_of_birth)))::int AS age_months,
  d.updated_at,h.metro_id,g.display_name AS guardian_name,g.country_code,
  t.energy,t.play_style,t.dog_reactivity,t.human_reactivity,t.size_tolerance,
  greatest(1,coalesce((SELECT max(v.tier) FROM verify.tiers_granted v WHERE v.subject_type='dog'
    AND v.subject_id=d.id AND v.revoked_at IS NULL AND (v.expires_at IS NULL OR v.expires_at>now())),0)) AS effective_tier
FROM graph.dogs d JOIN identity.households h ON h.id=d.household_id
JOIN graph.discovery_guardians g ON g.id=d.published_by
JOIN identity.household_members m ON m.household_id=h.id AND m.user_id=g.id AND m.accepted_at IS NOT NULL AND m.role IN ('owner','co_guardian')
JOIN ops.metros area ON area.id=h.metro_id AND area.country=g.country_code AND area.launch_state IN ('seeding','soft_launch','open')
JOIN graph.dog_temperament t ON t.dog_id=d.id
JOIN graph.match_preferences pref ON pref.dog_id=d.id AND pref.allow_city_only
WHERE d.status='active' AND d.publication_state='published' AND d.deleted_at IS NULL AND h.deleted_at IS NULL
  AND h.location_source='manual_area' AND d.date_of_birth IS NOT NULL AND d.date_of_birth<=current_date AND d.neutered IS NOT NULL
  AND (SELECT coalesce(sum(b.percentage),0) FROM graph.dog_breeds b WHERE b.dog_id=d.id)=100
  AND (SELECT count(*) FROM graph.dog_media photo LEFT JOIN graph.media_uploads upload ON upload.media_id=photo.id
    WHERE photo.dog_id=d.id AND photo.kind='photo' AND photo.moderation_state='approved' AND photo.deleted_at IS NULL
      AND (upload.media_id IS NULL OR upload.state='completed'))>=3;

CREATE TABLE graph.discovery_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  actor_dog_id uuid NOT NULL REFERENCES graph.dogs(id) ON DELETE CASCADE,
  context_hash text NOT NULL,
  target_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE INDEX discovery_sessions_user_created ON graph.discovery_sessions(user_id,created_at);
CREATE TABLE graph.discovery_profile_reads (
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  day date NOT NULL,
  dog_id uuid NOT NULL REFERENCES graph.dogs(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,day,dog_id)
);
