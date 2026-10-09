CREATE TABLE safety.meetup_incident_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 review_id uuid NOT NULL UNIQUE REFERENCES meetup.meetup_reviews(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','in_review','dismissed','escalated')),
 assigned_staff_id uuid REFERENCES ops.staff_accounts(id),
 reason_code text CHECK(reason_code ~ '^[a-z0-9_-]{3,60}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 first_action_at timestamptz,
 decided_at timestamptz
);
CREATE INDEX meetup_incident_case_queue ON safety.meetup_incident_cases(state,created_at,id);
CREATE FUNCTION safety.queue_meetup_incident() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.incident_occurred OR NEW.private_note_encrypted IS NOT NULL THEN
  INSERT INTO safety.meetup_incident_cases(review_id) VALUES(NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER queue_meetup_incident AFTER INSERT ON meetup.meetup_reviews
 FOR EACH ROW EXECUTE FUNCTION safety.queue_meetup_incident();
