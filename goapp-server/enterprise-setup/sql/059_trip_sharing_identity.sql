-- ============================================================
-- GoApp Enterprise Schema: 059 - Trip Sharing (Identity Domain)
-- Domain: Identity / Safety
-- ============================================================

ALTER TABLE trusted_contacts_shares
  ADD COLUMN IF NOT EXISTS tracking_share_id UUID,
  ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS provider_name VARCHAR(50),
  ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_trusted_contacts_shares_user_ride
  ON trusted_contacts_shares (user_id, ride_id, shared_at DESC);

CREATE INDEX IF NOT EXISTS idx_trusted_contacts_shares_contact_status
  ON trusted_contacts_shares (contact_id, delivery_status, shared_at DESC);
