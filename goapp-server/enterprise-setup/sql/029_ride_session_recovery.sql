-- ============================================================
-- GoApp Enterprise Schema: 029 - Ride Session Recovery
-- Domain: App kill/close recovery for in-progress rides (2 tables)
-- ============================================================
--
-- Problem Solved:
--   When a rider's app is force-closed or killed during an active ride,
--   on reopen they should seamlessly continue tracking the in-progress ride.
--
-- Recovery Flow:
--   1. App opens → GET /riders/:riderId/active-ride → { hasActiveRide: true, rideId }
--   2. App calls  → POST /riders/:riderId/restore  → full ride + driver snapshot
--   3. App connects WebSocket → { action: 'reconnect', rideId }
--   4. App pings  → POST /riders/:riderId/heartbeat (every 30s while open)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Rider app sessions (tracks app lifecycle: foreground / background / killed)
--    One row per rider, updated continuously while ride is active.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rider_app_sessions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id                UUID NOT NULL,                         -- references riders(id)
    ride_id                 UUID,                                  -- references rides(id)
    session_token           VARCHAR(200),                          -- current auth session
    device_platform         VARCHAR(10)
                            CHECK (device_platform IN ('ios','android','web')),
    app_state               VARCHAR(15) NOT NULL DEFAULT 'foreground'
                            CHECK (app_state IN ('foreground','background','killed','unknown')),
    ws_connected            BOOLEAN NOT NULL DEFAULT false,        -- is WS currently open?
    last_heartbeat_at       TIMESTAMPTZ,                           -- last ping from app
    last_restored_at        TIMESTAMPTZ,                           -- last /restore call
    recovery_count          INTEGER NOT NULL DEFAULT 0,            -- total restores for this ride
    foreground_at           TIMESTAMPTZ,
    background_at           TIMESTAMPTZ,
    killed_at               TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(rider_id, ride_id)                                      -- one session per ride
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_rider    ON rider_app_sessions(rider_id);
CREATE INDEX IF NOT EXISTS idx_app_sessions_ride     ON rider_app_sessions(ride_id) WHERE ride_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_sessions_state    ON rider_app_sessions(app_state, last_heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_sessions_heartbeat ON rider_app_sessions(last_heartbeat_at DESC);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_app_session_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER app_session_updated_at
    BEFORE UPDATE ON rider_app_sessions
    FOR EACH ROW EXECUTE FUNCTION update_app_session_timestamp();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Ride recovery audit log (one row per recovery/heartbeat/ws-reconnect event)
--    Immutable append-only log. Used for debugging, analytics, SLA tracking.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ride_recovery_log (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    log_code                VARCHAR(30) NOT NULL,                  -- REC-1234-XYZ
    rider_id                UUID NOT NULL,
    ride_id                 VARCHAR(50),
    recovery_type           VARCHAR(20) NOT NULL
                            CHECK (recovery_type IN (
                                'restore',        -- POST /riders/:id/restore called
                                'heartbeat',      -- POST /riders/:id/heartbeat ping
                                'ws_reconnect',   -- WebSocket reconnect action received
                                'active_check',   -- GET /riders/:id/active-ride called
                                'fcm_wakeup'      -- App woken by silent FCM push
                            )),
    ride_status_at_recovery VARCHAR(30),          -- e.g. 'TRIP_STARTED'
    elapsed_sec_at_recovery INTEGER,              -- seconds since trip started
    recovery_count          INTEGER,              -- how many times recovered for this ride
    app_was_killed          BOOLEAN DEFAULT false,
    ws_was_connected        BOOLEAN DEFAULT false,
    success                 BOOLEAN NOT NULL DEFAULT true,
    error_message           TEXT,
    device_platform         VARCHAR(10),
    metadata                JSONB DEFAULT '{}',   -- extra context (IP, app version, etc.)
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recovery_log_rider  ON ride_recovery_log(rider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recovery_log_ride   ON ride_recovery_log(ride_id, created_at DESC) WHERE ride_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recovery_log_type   ON ride_recovery_log(recovery_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recovery_log_killed ON ride_recovery_log(app_was_killed, created_at DESC) WHERE app_was_killed = true;

-- Ride Session Recovery: 2 tables total
-- rider_app_sessions: live state (foreground/background/killed, heartbeat)
-- ride_recovery_log:  immutable audit trail of every recovery attempt
