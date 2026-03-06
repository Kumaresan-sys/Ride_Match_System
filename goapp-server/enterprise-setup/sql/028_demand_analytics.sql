-- ============================================================
-- GoApp Enterprise Schema: 028 - Demand Analytics & Logging
-- Domain: Time-series demand, area heatmap, full scenario logs
-- 5 tables
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Area demand snapshots (periodic ~5 min snapshots per active grid cell)
--    Grid key: lat rounded to 2 decimal places + '_' + lng = ~1.1 km cells
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS demand_area_snapshots (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    area_key            VARCHAR(30) NOT NULL,          -- "12.97_77.59"
    center_lat          DECIMAL(10,7) NOT NULL,
    center_lng          DECIMAL(10,7) NOT NULL,
    active_requests     INTEGER NOT NULL DEFAULT 0,    -- pending requests at snapshot time
    open_pools          INTEGER NOT NULL DEFAULT 0,    -- open/filling pools in cell
    available_drivers   INTEGER NOT NULL DEFAULT 0,    -- nearby drivers in cell
    demand_ratio        DECIMAL(6,2) NOT NULL DEFAULT 0, -- active_requests / max(drivers,1)
    demand_level        VARCHAR(10) NOT NULL DEFAULT 'LOW'
                        CHECK (demand_level IN ('LOW','MEDIUM','HIGH','SURGE')),
    total_requests_today INTEGER NOT NULL DEFAULT 0,
    total_savings_today DECIMAL(12,2) NOT NULL DEFAULT 0,
    surge_multiplier    DECIMAL(4,2) DEFAULT 1.0,
    snapshot_time       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_demand_area_key      ON demand_area_snapshots(area_key, snapshot_time DESC);
CREATE INDEX IF NOT EXISTS idx_demand_area_level    ON demand_area_snapshots(demand_level, snapshot_time DESC) WHERE demand_level IN ('HIGH','SURGE');
CREATE INDEX IF NOT EXISTS idx_demand_area_location ON demand_area_snapshots(center_lat, center_lng, snapshot_time DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Time-series demand buckets (15-minute windows)
--    Tracks demand patterns for: today's timeline, peak hour detection,
--    pool match rate trends, savings generated over time
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS demand_time_buckets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_key          VARCHAR(20) NOT NULL,           -- "2026-03-06 09:45"
    start_time          TIMESTAMPTZ NOT NULL,
    end_time            TIMESTAMPTZ NOT NULL,
    total_requests      INTEGER NOT NULL DEFAULT 0,     -- all ride + pool requests
    pool_matches        INTEGER NOT NULL DEFAULT 0,     -- riders who joined existing pool
    new_pools           INTEGER NOT NULL DEFAULT 0,     -- fresh pools created
    no_matches          INTEGER NOT NULL DEFAULT 0,     -- requests with no compatible pool
    pool_completed      INTEGER NOT NULL DEFAULT 0,
    pool_expired        INTEGER NOT NULL DEFAULT 0,
    pool_cancelled      INTEGER NOT NULL DEFAULT 0,
    avg_wait_sec        INTEGER DEFAULT 0,              -- avg time from pool_created to dispatch
    total_savings_inr   DECIMAL(12,2) NOT NULL DEFAULT 0,
    peak_hour           BOOLEAN NOT NULL DEFAULT false,
    day_of_week         SMALLINT,                       -- 0=Sun … 6=Sat
    hour_of_day         SMALLINT,                       -- 0–23
    pool_match_rate_pct DECIMAL(5,2),                   -- pool_matches / total_requests * 100
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(bucket_key)
);

CREATE INDEX IF NOT EXISTS idx_time_buckets_start ON demand_time_buckets(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_time_buckets_peak  ON demand_time_buckets(peak_hour, total_requests DESC) WHERE peak_hour = true;
CREATE INDEX IF NOT EXISTS idx_time_buckets_hour  ON demand_time_buckets(hour_of_day, day_of_week);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Scenario event logs (complete audit trail of every demand event)
--    Every pool lifecycle event, match attempt, and no-match is recorded here.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS demand_scenario_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    log_code            VARCHAR(40) NOT NULL,           -- LOG-1234-ABCD
    scenario_type       VARCHAR(30) NOT NULL
                        CHECK (scenario_type IN (
                            'pool_created',    -- New pool opened
                            'pool_joined',     -- Rider joined existing pool
                            'pool_left',       -- Rider left pool
                            'no_match_found',  -- smartMatch found no compatible pool
                            'match_attempt',   -- Any smartMatch call (joined or created)
                            'pool_dispatched', -- Driver assigned to pool
                            'pool_expired',    -- Pool timed out unfilled
                            'pool_completed',  -- Pool ride finished successfully
                            'pool_cancelled',  -- Pool cancelled (all riders left)
                            'demand_snapshot', -- Periodic area demand snapshot
                            'ride_requested',  -- Raw ride request (solo or pool)
                            'ride_completed'   -- Ride finished
                        )),
    actor_id            VARCHAR(100),                   -- riderId, driverId, or 'system'
    pool_id             VARCHAR(50),                    -- POOL-xxx if relevant
    area_key            VARCHAR(30),                    -- grid cell key
    pickup_lat          DECIMAL(10,7),
    pickup_lng          DECIMAL(10,7),
    dest_lat            DECIMAL(10,7),
    dest_lng            DECIMAL(10,7),
    direction_bearing   DECIMAL(6,2),
    event_data          JSONB NOT NULL DEFAULT '{}',    -- full scenario-specific payload
    outcome             VARCHAR(30),                    -- joined, created, expired, completed, failed
    peak_hour           BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scenario_type       ON demand_scenario_logs(scenario_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scenario_actor      ON demand_scenario_logs(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scenario_pool       ON demand_scenario_logs(pool_id, created_at DESC) WHERE pool_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scenario_area       ON demand_scenario_logs(area_key, created_at DESC) WHERE area_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scenario_peak       ON demand_scenario_logs(peak_hour, created_at DESC) WHERE peak_hour = true;
CREATE INDEX IF NOT EXISTS idx_scenario_time       ON demand_scenario_logs(created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Match failure detail log (why each pool was rejected during matching)
--    One row per pool checked and rejected. A single no_match_found event
--    can produce multiple rows (one per pool checked).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS demand_match_failures (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scenario_log_id     UUID REFERENCES demand_scenario_logs(id),
    rider_id            VARCHAR(100) NOT NULL,
    checked_pool_id     VARCHAR(50) NOT NULL,           -- which pool was checked
    fail_reason         VARCHAR(30) NOT NULL
                        CHECK (fail_reason IN (
                            'pickup_too_far',      -- pickup distance > POOL_PICKUP_RADIUS_KM
                            'bearing_mismatch',    -- direction difference > POOL_BEARING_TOLERANCE_DEG
                            'dest_too_far',        -- destination distance > POOL_DEST_RANGE_KM
                            'pool_full',           -- pool at max_riders capacity
                            'ride_type_mismatch',  -- rideType (sedan/mini) doesn't match
                            'already_in_pool',     -- rider is already in this pool
                            'pool_expired',        -- pool past expiry time
                            'pool_wrong_status'    -- pool is DISPATCHING/ACTIVE/etc.
                        )),
    measured_value      DECIMAL(10,4),                  -- the actual distance/angle that failed
    threshold_value     DECIMAL(10,4),                  -- the configured limit
    checked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_failures_rider  ON demand_match_failures(rider_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_failures_pool   ON demand_match_failures(checked_pool_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_failures_reason ON demand_match_failures(fail_reason, checked_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Daily demand summary (one row per day — computed at end-of-day or on demand)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS demand_daily_summary (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    summary_date            DATE NOT NULL UNIQUE,
    total_requests          INTEGER NOT NULL DEFAULT 0,
    pool_requests           INTEGER NOT NULL DEFAULT 0,   -- requests that went through pool matching
    solo_requests           INTEGER NOT NULL DEFAULT 0,   -- requests that skipped pooling
    pool_matches            INTEGER NOT NULL DEFAULT 0,   -- riders who joined existing pool
    new_pools_created       INTEGER NOT NULL DEFAULT 0,
    pools_completed         INTEGER NOT NULL DEFAULT 0,
    pools_expired           INTEGER NOT NULL DEFAULT 0,
    pools_cancelled         INTEGER NOT NULL DEFAULT 0,
    pool_match_rate_pct     DECIMAL(5,2),                 -- pool_matches / pool_requests * 100
    no_match_rate_pct       DECIMAL(5,2),                 -- no_matches / pool_requests * 100
    avg_wait_sec            INTEGER DEFAULT 0,
    peak_hour_requests      INTEGER NOT NULL DEFAULT 0,   -- requests during peak hours
    peak_hour_pct           DECIMAL(5,2),
    busiest_area_key        VARCHAR(30),
    busiest_area_requests   INTEGER,
    total_savings_inr       DECIMAL(14,2) NOT NULL DEFAULT 0,
    avg_savings_per_pool    DECIMAL(10,2),
    unique_riders_pooled    INTEGER NOT NULL DEFAULT 0,
    total_match_failures    INTEGER NOT NULL DEFAULT 0,
    top_fail_reason         VARCHAR(30),                  -- most common rejection reason
    computed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON demand_daily_summary(summary_date DESC);

-- Demand Analytics: 5 tables total
-- Covers: area snapshots, time-series buckets, scenario audit log,
--         match failure details, and daily summary rollups
