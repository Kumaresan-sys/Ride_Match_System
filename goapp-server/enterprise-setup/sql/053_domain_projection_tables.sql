-- ============================================================
-- 053_domain_projection_tables.sql
-- Read-model projections used to remove cross-domain joins
-- ============================================================

-- Rides domain projections
CREATE TABLE IF NOT EXISTS ride_rider_projection (
    rider_id         UUID PRIMARY KEY,
    user_id          UUID UNIQUE NOT NULL,
    display_name     VARCHAR(255),
    phone_number     VARCHAR(32),
    status           VARCHAR(32) DEFAULT 'active',
    total_rides      INTEGER DEFAULT 0,
    lifetime_spend   NUMERIC(12,2) DEFAULT 0,
    rider_tier       VARCHAR(64),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ride_rider_projection_user_id
  ON ride_rider_projection (user_id);

CREATE TABLE IF NOT EXISTS ride_driver_projection (
    driver_id           UUID PRIMARY KEY,
    user_id             UUID UNIQUE NOT NULL,
    display_name        VARCHAR(255),
    phone_number        VARCHAR(32),
    status              VARCHAR(32) DEFAULT 'active',
    onboarding_status   VARCHAR(64),
    is_eligible         BOOLEAN,
    home_city           VARCHAR(120),
    vehicle_number      VARCHAR(64),
    vehicle_type        VARCHAR(80),
    avatar_url          TEXT,
    avatar_version      BIGINT,
    average_rating      NUMERIC(4,2),
    acceptance_rate     NUMERIC(6,4),
    completion_rate     NUMERIC(6,4),
    completed_rides_count INTEGER DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ride_driver_projection_user_id
  ON ride_driver_projection (user_id);

-- Payments domain projections
CREATE TABLE IF NOT EXISTS payment_rider_projection (
    rider_id         UUID PRIMARY KEY,
    user_id          UUID UNIQUE NOT NULL,
    display_name     VARCHAR(255),
    phone_number     VARCHAR(32),
    status           VARCHAR(32) DEFAULT 'active',
    total_rides      INTEGER DEFAULT 0,
    lifetime_spend   NUMERIC(12,2) DEFAULT 0,
    rider_tier       VARCHAR(64),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_rider_projection_user_id
  ON payment_rider_projection (user_id);

CREATE TABLE IF NOT EXISTS payment_driver_projection (
    driver_id           UUID PRIMARY KEY,
    user_id             UUID UNIQUE NOT NULL,
    display_name        VARCHAR(255),
    phone_number        VARCHAR(32),
    status              VARCHAR(32) DEFAULT 'active',
    onboarding_status   VARCHAR(64),
    is_eligible         BOOLEAN,
    home_city           VARCHAR(120),
    vehicle_number      VARCHAR(64),
    vehicle_type        VARCHAR(80),
    avatar_url          TEXT,
    avatar_version      BIGINT,
    average_rating      NUMERIC(4,2),
    acceptance_rate     NUMERIC(6,4),
    completion_rate     NUMERIC(6,4),
    completed_rides_count INTEGER DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_driver_projection_user_id
  ON payment_driver_projection (user_id);

-- Drivers domain projections
CREATE TABLE IF NOT EXISTS driver_user_projection (
    driver_id           UUID PRIMARY KEY,
    user_id             UUID UNIQUE NOT NULL,
    display_name        VARCHAR(255),
    phone_number        VARCHAR(32),
    status              VARCHAR(32) DEFAULT 'active',
    onboarding_status   VARCHAR(64),
    is_eligible         BOOLEAN,
    home_city           VARCHAR(120),
    vehicle_number      VARCHAR(64),
    vehicle_type        VARCHAR(80),
    avatar_url          TEXT,
    avatar_version      BIGINT,
    average_rating      NUMERIC(4,2),
    acceptance_rate     NUMERIC(6,4),
    completion_rate     NUMERIC(6,4),
    completed_rides_count INTEGER DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_user_projection_user_id
  ON driver_user_projection (user_id);

CREATE TABLE IF NOT EXISTS rider_user_projection (
    rider_id         UUID PRIMARY KEY,
    user_id          UUID UNIQUE NOT NULL,
    display_name     VARCHAR(255),
    phone_number     VARCHAR(32),
    status           VARCHAR(32) DEFAULT 'active',
    total_rides      INTEGER DEFAULT 0,
    lifetime_spend   NUMERIC(12,2) DEFAULT 0,
    rider_tier       VARCHAR(64),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rider_user_projection_user_id
  ON rider_user_projection (user_id);

-- Analytics domain projection
CREATE TABLE IF NOT EXISTS analytics_rider_projection (
    rider_id     UUID PRIMARY KEY,
    user_id      UUID UNIQUE NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_rider_projection_user_id
  ON analytics_rider_projection (user_id);
