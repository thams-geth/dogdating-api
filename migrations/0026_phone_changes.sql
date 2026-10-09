ALTER TABLE identity.otp_challenges DROP CONSTRAINT otp_challenges_purpose_check;
ALTER TABLE identity.otp_challenges ADD CONSTRAINT otp_challenges_purpose_check CHECK(purpose IN ('auth','privacy','phone_change'));
ALTER TABLE identity.otp_challenges ADD COLUMN requested_by uuid REFERENCES identity.users(id) ON DELETE CASCADE;
