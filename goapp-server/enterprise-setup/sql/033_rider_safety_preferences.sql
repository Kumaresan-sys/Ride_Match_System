-- ============================================================
-- GoApp Schema: 033 - Rider Safety Preferences & Contact Soft-Delete
-- ============================================================

-- Soft-delete support for emergency_contacts
ALTER TABLE emergency_contacts
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_emergency_contacts_active
  ON emergency_contacts (user_id)
  WHERE deleted_at IS NULL;

-- Safety preferences per rider
CREATE TABLE IF NOT EXISTS safety_preferences (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auto_share     BOOLEAN NOT NULL DEFAULT false,
  share_at_night BOOLEAN NOT NULL DEFAULT false,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
