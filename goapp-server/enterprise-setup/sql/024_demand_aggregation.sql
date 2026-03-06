-- ============================================================
-- GoApp Enterprise Schema: 024 - Demand Aggregation (Ride Pooling)
-- Domain: Pool ride requests going same direction (4 tables)
-- ============================================================

CREATE TABLE IF NOT EXISTS ride_pools (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_code           VARCHAR(30) UNIQUE NOT NULL,   -- Human-readable: POOL-1234-ABCD
    status              VARCHAR(20) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','filling','dispatching','active','completed','expired','cancelled')),
    ride_type           VARCHAR(20) NOT NULL DEFAULT 'sedan',
    pickup_lat          DECIMAL(10,7) NOT NULL,
    pickup_lng          DECIMAL(10,7) NOT NULL,
    pickup_address      TEXT,
    dest_lat            DECIMAL(10,7) NOT NULL,
    dest_lng            DECIMAL(10,7) NOT NULL,
    dest_address        TEXT,
    direction_bearing   DECIMAL(6,2),           -- Bearing angle (0-360°) for matching
    distance_km         DECIMAL(8,2),
    full_fare_inr       DECIMAL(10,2),           -- What single rider would pay
    fare_per_rider_inr  DECIMAL(10,2),           -- Discounted pooled fare per rider
    discount_pct        DECIMAL(5,2) DEFAULT 40, -- % discount vs solo ride
    max_riders          SMALLINT NOT NULL DEFAULT 4,
    current_riders      SMALLINT NOT NULL DEFAULT 0,
    assigned_driver_id  UUID REFERENCES drivers(id),
    assigned_ride_id    UUID REFERENCES rides(id),
    expires_at          TIMESTAMPTZ NOT NULL,
    dispatched_at       TIMESTAMPTZ,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pools_status    ON ride_pools(status, expires_at) WHERE status IN ('open','filling');
CREATE INDEX IF NOT EXISTS idx_pools_pickup    ON ride_pools(pickup_lat, pickup_lng) WHERE status IN ('open','filling');
CREATE INDEX IF NOT EXISTS idx_pools_bearing   ON ride_pools(direction_bearing) WHERE status IN ('open','filling');
CREATE INDEX IF NOT EXISTS idx_pools_driver    ON ride_pools(assigned_driver_id) WHERE assigned_driver_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Pool participants (each rider in the pool)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pool_participants (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id             UUID NOT NULL REFERENCES ride_pools(id) ON DELETE CASCADE,
    rider_id            UUID NOT NULL REFERENCES riders(id),
    pickup_lat          DECIMAL(10,7) NOT NULL,
    pickup_lng          DECIMAL(10,7) NOT NULL,
    pickup_address      TEXT,
    pickup_order        SMALLINT,               -- Order in which driver picks up
    fare_inr            DECIMAL(10,2),          -- This rider's share
    payment_method      VARCHAR(20) DEFAULT 'cash',
    payment_status      VARCHAR(20) DEFAULT 'pending'
                        CHECK (payment_status IN ('pending','paid','refunded','failed')),
    status              VARCHAR(20) NOT NULL DEFAULT 'waiting'
                        CHECK (status IN ('waiting','picked_up','dropped','cancelled','no_show')),
    joined_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    picked_up_at        TIMESTAMPTZ,
    dropped_at          TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    cancel_reason       TEXT,
    UNIQUE(pool_id, rider_id)
);

CREATE INDEX IF NOT EXISTS idx_pool_participants_pool   ON pool_participants(pool_id);
CREATE INDEX IF NOT EXISTS idx_pool_participants_rider  ON pool_participants(rider_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Pool match events (audit trail of matching decisions)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pool_match_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id             UUID REFERENCES ride_pools(id),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    event_type          VARCHAR(30) NOT NULL
                        CHECK (event_type IN ('pool_created','pool_joined','pool_left','pool_dispatched',
                                              'pool_started','pool_completed','pool_expired','no_match_found')),
    pickup_dist_km      DECIMAL(8,3),           -- Distance from rider to pool pickup
    bearing_diff_deg    DECIMAL(6,2),           -- Direction difference in degrees
    dest_dist_km        DECIMAL(8,3),           -- Distance between destinations
    fare_inr            DECIMAL(10,2),
    savings_inr         DECIMAL(10,2),
    metadata            JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pool_events_pool  ON pool_match_events(pool_id);
CREATE INDEX IF NOT EXISTS idx_pool_events_rider ON pool_match_events(rider_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Demand heatmap snapshots (aggregated demand by H3 cell & time)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS demand_heatmap (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    h3_index            VARCHAR(20) NOT NULL,
    snapshot_time       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ride_requests       INTEGER DEFAULT 0,
    pool_requests       INTEGER DEFAULT 0,
    active_drivers      INTEGER DEFAULT 0,
    demand_supply_ratio DECIMAL(5,2),           -- requests / drivers
    surge_multiplier    DECIMAL(4,2) DEFAULT 1.0,
    top_destinations    JSONB,                  -- [{ lat, lng, count }]
    avg_wait_sec        INTEGER,
    UNIQUE(h3_index, snapshot_time)
);

CREATE INDEX IF NOT EXISTS idx_demand_heatmap_h3   ON demand_heatmap(h3_index, snapshot_time DESC);
CREATE INDEX IF NOT EXISTS idx_demand_heatmap_time ON demand_heatmap(snapshot_time DESC);

-- Demand Aggregation: 4 tables total
