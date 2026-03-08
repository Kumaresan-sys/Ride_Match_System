-- Backfill profile fields required by the current application contract.
-- Safe to run repeatedly on existing databases.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS emergency_contact VARCHAR(20);

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS date_of_birth DATE;
