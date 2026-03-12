-- ============================================================
-- GoApp Enterprise Schema: 060 - Trip Sharing (Rides Domain)
-- Domain: Rides / Tracking / Audit
-- ============================================================

CREATE TABLE IF NOT EXISTS ride_tracking_shares (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    rider_user_id       UUID NOT NULL,
    contact_id          UUID NOT NULL,
    token               VARCHAR(128) NOT NULL UNIQUE,
    status              VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','expired','revoked','completed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    last_viewed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ride_tracking_shares_ride_contact
  ON ride_tracking_shares (ride_id, contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ride_tracking_shares_status_expiry
  ON ride_tracking_shares (status, expires_at, created_at DESC);

CREATE TABLE IF NOT EXISTS trip_share_delivery_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tracking_share_id   UUID NOT NULL REFERENCES ride_tracking_shares(id),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    channel             VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
    provider_name       VARCHAR(50),
    delivery_status     VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (delivery_status IN ('pending','sent','failed','delivered','viewed')),
    provider_message_id VARCHAR(255),
    failure_reason      TEXT,
    provider_response   JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_share_delivery_logs_share
  ON trip_share_delivery_logs (tracking_share_id, created_at DESC);
