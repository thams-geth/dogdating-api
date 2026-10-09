ALTER TABLE meetup.meetups ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 ADD COLUMN cancellation_reason text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE meetup.meetup_reviews ADD COLUMN private_note_encrypted bytea;
-- Ending a connection closes every active meeting in the same source transaction.
CREATE FUNCTION meetup.cancel_connection_meetups() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state<>'active' AND OLD.state='active' THEN
  UPDATE meetup.meetups SET state='cancelled',cancellation_reason='connection_ended',revision=revision+1,updated_at=now()
   WHERE match_id=NEW.id AND state IN ('proposed','accepted','in_progress');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cancel_connection_meetups AFTER UPDATE OF state ON meetup.matches FOR EACH ROW EXECUTE FUNCTION meetup.cancel_connection_meetups();
