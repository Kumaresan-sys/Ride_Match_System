-- ============================================================
-- GoApp Schema: 034 - Logout Audit Log
-- ============================================================

CREATE TABLE IF NOT EXISTS user_logout_logs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id),
  session_id            UUID REFERENCES user_sessions(id),
  logout_type           VARCHAR(20)  NOT NULL DEFAULT 'voluntary'
                        CHECK (logout_type IN ('voluntary','forced','expired','admin','token_revoked')),
  ip_address            INET,
  user_agent            TEXT,
  device_id             UUID REFERENCES user_devices(id),
  session_started_at    TIMESTAMPTZ,
  session_duration_sec  INTEGER,         -- seconds from login to logout
  had_active_ride       BOOLEAN NOT NULL DEFAULT false,
  had_pending_payment   BOOLEAN NOT NULL DEFAULT false,
  logged_out_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logout_logs_user
  ON user_logout_logs (user_id, logged_out_at DESC);

CREATE INDEX IF NOT EXISTS idx_logout_logs_date
  ON user_logout_logs (logged_out_at DESC);
