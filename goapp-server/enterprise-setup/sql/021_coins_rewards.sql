-- ============================================================
-- GoApp Enterprise Schema: 021 - Coins / Rewards System
-- Domain: Loyalty & Coins (6 tables)
-- Coins are an in-app currency earned on rides and redeemable
-- as optional discounts at payment time.
-- ============================================================

-- User coin wallets
CREATE TABLE IF NOT EXISTS coin_wallets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL UNIQUE REFERENCES users(id),
    balance             INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    lifetime_earned     INTEGER NOT NULL DEFAULT 0,
    lifetime_redeemed   INTEGER NOT NULL DEFAULT 0,
    status              VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'frozen', 'suspended')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coin_wallets_user ON coin_wallets(user_id);

-- Individual coin transactions (earn / redeem / adjust / expire)
CREATE TABLE IF NOT EXISTS coin_transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES coin_wallets(id),
    user_id             UUID NOT NULL REFERENCES users(id),
    transaction_type    VARCHAR(20) NOT NULL
                        CHECK (transaction_type IN ('earn', 'redeem', 'credit', 'debit', 'expire', 'refund')),
    coins               INTEGER NOT NULL,          -- positive = earn/credit, negative = redeem/debit
    balance_before      INTEGER NOT NULL,
    balance_after       INTEGER NOT NULL,
    reference_type      VARCHAR(30),               -- 'ride', 'promo', 'referral', 'admin'
    reference_id        UUID,                      -- rideId, promoId, etc.
    description         TEXT,
    idempotency_key     VARCHAR(200) UNIQUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coin_txn_wallet ON coin_transactions(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coin_txn_user   ON coin_transactions(user_id, created_at DESC);

-- Coin redemptions linked to ride payments
CREATE TABLE IF NOT EXISTS coin_redemptions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    ride_id             UUID NOT NULL REFERENCES rides(id),
    coins_redeemed      INTEGER NOT NULL CHECK (coins_redeemed > 0),
    discount_inr        DECIMAL(10,2) NOT NULL,
    original_fare_inr   DECIMAL(10,2) NOT NULL,
    final_fare_inr      DECIMAL(10,2) NOT NULL,
    coin_inr_rate       DECIMAL(6,4) NOT NULL,     -- snapshot of rate at redemption time
    status              VARCHAR(20) NOT NULL DEFAULT 'applied'
                        CHECK (status IN ('applied', 'reversed', 'expired')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reversed_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_coin_redemptions_ride ON coin_redemptions(ride_id);
CREATE INDEX IF NOT EXISTS idx_coin_redemptions_user ON coin_redemptions(user_id);

-- Coin earning rules (configurable by admin)
CREATE TABLE IF NOT EXISTS coin_earn_rules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_name           VARCHAR(100) NOT NULL,
    rule_type           VARCHAR(30) NOT NULL
                        CHECK (rule_type IN ('per_ride_fare', 'per_ride_flat', 'referral', 'promo_bonus', 'signup')),
    coins_per_inr       DECIMAL(8,4),              -- for per_ride_fare type
    flat_coins          INTEGER,                   -- for per_ride_flat, referral, signup
    min_fare_inr        DECIMAL(10,2),             -- minimum fare to qualify
    max_coins_per_ride  INTEGER,                   -- cap per ride
    valid_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until         TIMESTAMPTZ,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Coin expiry schedules
CREATE TABLE IF NOT EXISTS coin_expiry_schedules (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES coin_wallets(id),
    coins               INTEGER NOT NULL CHECK (coins > 0),
    earned_at           TIMESTAMPTZ NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    is_expired          BOOLEAN NOT NULL DEFAULT false,
    expired_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_coin_expiry ON coin_expiry_schedules(wallet_id, expires_at) WHERE is_expired = false;

-- Coin config (system-wide parameters)
CREATE TABLE IF NOT EXISTS coin_config (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_key          VARCHAR(100) UNIQUE NOT NULL,
    config_value        TEXT NOT NULL,
    description         TEXT,
    updated_by          UUID REFERENCES users(id),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default config values
INSERT INTO coin_config (config_key, config_value, description) VALUES
  ('coin_inr_value',     '0.10',  '1 coin = ₹0.10 discount'),
  ('coins_per_inr_earn', '10',    'earn 1 coin per ₹10 of fare'),
  ('min_redeem_coins',   '10',    'minimum coins needed to redeem'),
  ('max_redeem_pct',     '0.20',  'max 20% of fare can be discounted via coins'),
  ('coin_expiry_days',   '365',   'coins expire after N days of inactivity')
ON CONFLICT (config_key) DO NOTHING;

-- Coins / Rewards: 6 tables total
