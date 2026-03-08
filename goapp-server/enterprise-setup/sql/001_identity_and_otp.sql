-- ============================================================
-- GoApp Enterprise Schema: 001 - Identity & OTP Service
-- Domain: Identity Service (17 tables)
-- Aligned to: GoApp-Enterprise-Architecture-248-Tables-OTP-Login.md
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ──────────────────────────────────────────────────────
-- Core User Tables
-- ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number        VARCHAR(20) UNIQUE NOT NULL,
    email               VARCHAR(255) UNIQUE,
    phone_verified      BOOLEAN DEFAULT false,
    user_type           VARCHAR(20) NOT NULL CHECK (user_type IN ('rider','driver','admin','support')),
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','active','suspended','deactivated','banned')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    version             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS user_profiles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    first_name          VARCHAR(100),
    last_name           VARCHAR(100),
    display_name        VARCHAR(200),
    avatar_url          TEXT,
    date_of_birth       DATE,
    gender              VARCHAR(20),
    emergency_contact   VARCHAR(20),
    language            VARCHAR(10) DEFAULT 'en',
    country_code        VARCHAR(5),
    city                VARCHAR(100),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_user ON user_profiles(user_id);

CREATE TABLE IF NOT EXISTS user_roles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    role                VARCHAR(50) NOT NULL,
    granted_by          UUID REFERENCES users(id),
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ,
    is_active           BOOLEAN DEFAULT true,
    UNIQUE(user_id, role)
);

CREATE TABLE IF NOT EXISTS user_status_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    old_status          VARCHAR(20),
    new_status          VARCHAR(20) NOT NULL,
    reason              TEXT,
    changed_by          UUID REFERENCES users(id),
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_status_history_user ON user_status_history(user_id);

CREATE TABLE IF NOT EXISTS user_devices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    device_id           VARCHAR(255) NOT NULL,
    device_type         VARCHAR(20) CHECK (device_type IN ('ios','android','web')),
    device_model        VARCHAR(100),
    os_version          VARCHAR(50),
    app_version         VARCHAR(50),
    fcm_token           TEXT,
    apns_token          TEXT,
    is_active           BOOLEAN DEFAULT true,
    last_active_at      TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_fcm ON user_devices(fcm_token);

CREATE TABLE IF NOT EXISTS user_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    device_id           UUID REFERENCES user_devices(id),
    session_token       VARCHAR(512) UNIQUE NOT NULL,
    refresh_token       VARCHAR(512) UNIQUE,
    ip_address          INET,
    user_agent          TEXT,
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS user_login_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    login_method        VARCHAR(30) NOT NULL CHECK (login_method IN ('otp')),
    ip_address          INET,
    device_id           UUID REFERENCES user_devices(id),
    status              VARCHAR(20) NOT NULL CHECK (status IN ('success','failed','blocked')),
    failure_reason      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_login_history_user ON user_login_history(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_blocklist (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    blocked_user_id     UUID NOT NULL REFERENCES users(id),
    reason              TEXT,
    blocked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, blocked_user_id)
);

CREATE TABLE IF NOT EXISTS user_preferences (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    preference_key      VARCHAR(100) NOT NULL,
    preference_value    JSONB NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, preference_key)
);

CREATE TABLE IF NOT EXISTS user_security_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    event_type          VARCHAR(50) NOT NULL,
    event_detail        JSONB,
    ip_address          INET,
    device_id           UUID REFERENCES user_devices(id),
    risk_level          VARCHAR(10) CHECK (risk_level IN ('low','medium','high','critical')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_security_logs_user ON user_security_logs(user_id, created_at DESC);

-- ──────────────────────────────────────────────────────
-- OTP Authentication Tables
-- ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS otp_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number        VARCHAR(20) NOT NULL,
    otp_code            VARCHAR(64) NOT NULL,
    otp_type            VARCHAR(20) NOT NULL CHECK (otp_type IN ('login','signup','reset','verify')),
    channel             VARCHAR(10) CHECK (channel IN ('sms','whatsapp','voice')),
    status              VARCHAR(20) DEFAULT 'pending'
                        CHECK (status IN ('pending','verified','expired','failed')),
    attempts            INTEGER DEFAULT 0,
    max_attempts        INTEGER DEFAULT 3,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    verified_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_requests(phone_number, created_at DESC);

CREATE TABLE IF NOT EXISTS otp_attempts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    otp_request_id      UUID NOT NULL REFERENCES otp_requests(id),
    entered_code        VARCHAR(10) NOT NULL,
    is_correct          BOOLEAN NOT NULL,
    ip_address          INET,
    attempted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otp_rate_limits (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number        VARCHAR(20) NOT NULL,
    window_start        TIMESTAMPTZ NOT NULL,
    request_count       INTEGER DEFAULT 1,
    is_blocked          BOOLEAN DEFAULT false,
    blocked_until       TIMESTAMPTZ,
    UNIQUE(phone_number, window_start)
);
CREATE INDEX IF NOT EXISTS idx_otp_rate_phone ON otp_rate_limits(phone_number);

-- ──────────────────────────────────────────────────────
-- Security Tables
-- ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_api_keys (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    key_hash            VARCHAR(512) NOT NULL,
    key_prefix          VARCHAR(10) NOT NULL,
    label               VARCHAR(100),
    permissions         JSONB DEFAULT '[]',
    is_active           BOOLEAN DEFAULT true,
    last_used_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_permissions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    resource            VARCHAR(100) NOT NULL,
    action              VARCHAR(50) NOT NULL,
    conditions          JSONB,
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, resource, action)
);

-- Identity Service: 17 tables total
