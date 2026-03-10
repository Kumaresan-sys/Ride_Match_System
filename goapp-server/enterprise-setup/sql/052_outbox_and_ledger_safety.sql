-- ============================================================
-- 052_outbox_and_ledger_safety.sql
-- Transactional outbox + wallet ledger idempotency primitives
-- ============================================================

-- Transactional outbox (shared shape, domain-tagged)
CREATE TABLE IF NOT EXISTS outbox_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain           VARCHAR(32) NOT NULL,
    topic            VARCHAR(120) NOT NULL,
    partition_key    VARCHAR(255),
    event_type       VARCHAR(120) NOT NULL,
    aggregate_type   VARCHAR(80) NOT NULL,
    aggregate_id     VARCHAR(120) NOT NULL,
    event_version    INTEGER NOT NULL DEFAULT 1,
    payload          JSONB NOT NULL,
    region           VARCHAR(50) NOT NULL DEFAULT 'ap-south-1',
    idempotency_key  VARCHAR(255),
    status           VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    available_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at     TIMESTAMPTZ,
    last_error       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_outbox_status CHECK (status IN ('pending', 'processing', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_status_available
  ON outbox_events (status, available_at, created_at);

CREATE INDEX IF NOT EXISTS idx_outbox_events_topic_created
  ON outbox_events (topic, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outbox_events_aggregate
  ON outbox_events (aggregate_type, aggregate_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_events_domain_idempotency
  ON outbox_events (domain, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Wallet/ledger idempotency guardrail
CREATE TABLE IF NOT EXISTS ledger_idempotency (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain            VARCHAR(32) NOT NULL DEFAULT 'payments',
    actor_id          UUID,
    idempotency_key   VARCHAR(255) NOT NULL,
    request_hash      VARCHAR(128),
    status            VARCHAR(20) NOT NULL DEFAULT 'pending',
    response_payload  JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ledger_idempotency_status CHECK (status IN ('pending', 'completed', 'failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idempotency_domain_key
  ON ledger_idempotency (domain, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_ledger_idempotency_status_created
  ON ledger_idempotency (status, created_at DESC);

-- Hot-path ride list/query indexes
CREATE INDEX IF NOT EXISTS idx_rides_rider_created_at
  ON rides (rider_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rides_driver_created_at
  ON rides (driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rides_status_created_at
  ON rides (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ride_status_history_ride_created
  ON ride_status_history (ride_id, created_at);

-- Driver location geospatial index (if geog column exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'driver_locations'
      AND column_name = 'geog'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_driver_locations_geog ON driver_locations USING GIST (geog)';
  END IF;
END $$;

-- Wallet transaction hot-path index
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_created
  ON wallet_transactions (wallet_id, created_at DESC);
