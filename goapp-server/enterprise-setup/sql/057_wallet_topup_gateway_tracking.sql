-- ============================================================
-- 057_wallet_topup_gateway_tracking.sql
-- Durable Razorpay rider wallet top-up lifecycle + ledger metadata
-- ============================================================

ALTER TABLE rider_topup_requests
  ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS gateway_payment_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS gateway_signature TEXT,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_via VARCHAR(40),
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200),
  ADD COLUMN IF NOT EXISTS last_webhook_event_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rider_topup_requests_gateway_order_id
  ON rider_topup_requests (gateway_order_id)
  WHERE gateway_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rider_topup_requests_gateway_payment_id
  ON rider_topup_requests (gateway_payment_id)
  WHERE gateway_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rider_topup_requests_idempotency_key
  ON rider_topup_requests (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rider_topup_requests_rider_status_created
  ON rider_topup_requests (rider_id, status, initiated_at DESC);

ALTER TABLE payment_webhooks
  ADD COLUMN IF NOT EXISTS gateway_event_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS reference_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS reference_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS processed_result JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_webhooks_gateway_event
  ON payment_webhooks (gateway, gateway_event_id)
  WHERE gateway_event_id IS NOT NULL;

ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_payment_id
  ON wallet_transactions ((metadata->>'paymentId'))
  WHERE metadata ? 'paymentId';

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_order_id
  ON wallet_transactions ((metadata->>'orderId'))
  WHERE metadata ? 'orderId';
