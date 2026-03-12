-- Ensure emergency contact relationship is available in older environments.

ALTER TABLE emergency_contacts
  ADD COLUMN IF NOT EXISTS relationship VARCHAR(50);
