INSERT INTO safety.meetup_incident_cases(review_id)
SELECT id FROM meetup.meetup_reviews
WHERE incident_occurred OR private_note_encrypted IS NOT NULL
ON CONFLICT(review_id) DO NOTHING;
