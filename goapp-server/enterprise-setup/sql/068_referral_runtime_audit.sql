-- ============================================================
-- GoApp Migration: 068 - Referral Runtime Audit
-- Tightens runtime support for rider referral application, payout
-- linkage, and notification/audit observability.
-- ============================================================

ALTER TABLE referral_tracking
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS qualifying_ride_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS reward_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_tracking_referee_unique
  ON referral_tracking (referee_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_tracking_idempotency
  ON referral_tracking (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE referral_payouts
  ADD COLUMN IF NOT EXISTS reward_unit VARCHAR(20) NOT NULL DEFAULT 'coins',
  ADD COLUMN IF NOT EXISTS coin_transaction_id UUID,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_payouts_idempotency
  ON referral_payouts (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id     UUID NOT NULL REFERENCES referral_tracking(id) ON DELETE CASCADE,
  event_type      VARCHAR(40) NOT NULL,
  actor_user_id   UUID REFERENCES users(id),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_events_tracking
  ON referral_events (tracking_id, created_at DESC);

UPDATE referral_programs
SET referrer_reward = 100,
    referee_reward = 0,
    reward_type = 'wallet_credit',
    conditions = jsonb_build_object(
      'reward_unit', 'coins',
      'referrer_coins', 100,
      'referee_coins', 0
    )
WHERE program_name = 'GoApp Rider Referral';
