-- Performance indexes for high-volume ride, payment, and wallet access paths

CREATE INDEX IF NOT EXISTS idx_rides_rider_created_at_desc
  ON rides (rider_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rides_status_created_at_desc
  ON rides (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rides_pickup_zone_created_at_desc
  ON rides (pickup_zone_id, created_at DESC)
  WHERE pickup_zone_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_created_at_desc
  ON wallet_transactions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_reference_id
  ON wallet_transactions (reference_id)
  WHERE reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_driver_wallet_transactions_driver_created_at_desc
  ON driver_wallet_transactions (driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_ride_id
  ON payments (ride_id)
  WHERE ride_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_provider_order_id
  ON payments (provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_idempotency_key
  ON payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
