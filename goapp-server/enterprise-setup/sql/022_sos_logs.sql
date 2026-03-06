-- ============================================================
-- GoApp Enterprise Schema: 022 - SOS Logs (Extended)
-- Domain: Safety / SOS Runtime Logs (4 tables)
-- Extends 013_safety_sos.sql with operational log tables
-- used by the SosService runtime.
-- ============================================================

-- SOS log — mirrors SosService in-memory store for persistence
CREATE TABLE IF NOT EXISTS sos_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sos_id              VARCHAR(30) UNIQUE NOT NULL,      -- e.g. SOS-AB12CD34
    user_id             UUID NOT NULL REFERENCES users(id),
    user_type           VARCHAR(10) NOT NULL DEFAULT 'rider'
                        CHECK (user_type IN ('rider', 'driver', 'admin')),
    ride_id             UUID REFERENCES rides(id),
    sos_type            VARCHAR(30) NOT NULL
                        CHECK (sos_type IN ('PANIC', 'ACCIDENT', 'ROUTE_DEVIATE', 'SHARE_TRIP')),
    status              VARCHAR(20) NOT NULL DEFAULT 'TRIGGERED'
                        CHECK (status IN ('TRIGGERED', 'ACKNOWLEDGED', 'DISPATCHED', 'RESOLVED', 'FALSE_ALARM')),
    trigger_lat         DECIMAL(10,7),
    trigger_lng         DECIMAL(10,7),
    last_lat            DECIMAL(10,7),
    last_lng            DECIMAL(10,7),
    user_message        TEXT,
    status_history      JSONB NOT NULL DEFAULT '[]',
    triggered_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at     TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ,
    resolved_by         VARCHAR(200),
    resolution_note     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sos_logs_user     ON sos_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_sos_logs_ride     ON sos_logs(ride_id);
CREATE INDEX IF NOT EXISTS idx_sos_logs_status   ON sos_logs(status);
CREATE INDEX IF NOT EXISTS idx_sos_logs_time     ON sos_logs(triggered_at DESC);

-- SOS location track — breadcrumb of user location after SOS trigger
CREATE TABLE IF NOT EXISTS sos_location_track (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sos_id              VARCHAR(30) NOT NULL REFERENCES sos_logs(sos_id),
    lat                 DECIMAL(10,7) NOT NULL,
    lng                 DECIMAL(10,7) NOT NULL,
    speed_kmh           DECIMAL(6,2),
    accuracy_m          DECIMAL(8,2),
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sos_track ON sos_location_track(sos_id, recorded_at);

-- SOS notification log — which contacts/channels were notified
CREATE TABLE IF NOT EXISTS sos_notifications_sent (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sos_id              VARCHAR(30) NOT NULL REFERENCES sos_logs(sos_id),
    channel             VARCHAR(30) NOT NULL
                        CHECK (channel IN ('sms', 'push', 'email', 'call', 'police_api', 'in_app')),
    recipient_type      VARCHAR(30) NOT NULL
                        CHECK (recipient_type IN ('emergency_contact', 'safety_team', 'police', 'rider', 'driver', 'system')),
    recipient_id        UUID,
    recipient_phone     VARCHAR(20),
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
    provider_ref        VARCHAR(200),
    sent_at             TIMESTAMPTZ,
    delivered_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sos_notif ON sos_notifications_sent(sos_id);

-- SOS admin action log
CREATE TABLE IF NOT EXISTS sos_admin_actions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sos_id              VARCHAR(30) NOT NULL REFERENCES sos_logs(sos_id),
    admin_id            UUID REFERENCES users(id),
    action              VARCHAR(50) NOT NULL,      -- 'acknowledge', 'dispatch', 'resolve', 'note'
    notes               TEXT,
    metadata            JSONB,
    performed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sos_admin ON sos_admin_actions(sos_id);

-- SOS Logs (Extended): 4 tables total
