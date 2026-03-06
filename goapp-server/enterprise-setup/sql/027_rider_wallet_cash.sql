-- ============================================================
-- GoApp Enterprise Schema: 027 - Rider Cash Wallet
-- Domain: Rider prepaid cash wallet for ride payments (4 tables)
-- ============================================================

CREATE TABLE IF NOT EXISTS rider_wallets (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id                UUID NOT NULL UNIQUE REFERENCES riders(id) ON DELETE CASCADE,
    cash_balance            DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    coin_balance            INTEGER NOT NULL DEFAULT 0,
    max_balance_limit       DECIMAL(10,2) NOT NULL DEFAULT 50000.00,  -- Max wallet limit
    daily_topup_limit       DECIMAL(10,2) NOT NULL DEFAULT 10000.00,
    daily_topup_used        DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    daily_topup_reset_at    DATE NOT NULL DEFAULT CURRENT_DATE,
    is_frozen               BOOLEAN NOT NULL DEFAULT false,
    frozen_reason           TEXT,
    total_topup             DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    total_spent             DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    total_refunded          DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    total_coins_earned      INTEGER NOT NULL DEFAULT 0,
    total_coins_redeemed    INTEGER NOT NULL DEFAULT 0,
    last_topup_at           TIMESTAMPTZ,
    last_payment_at         TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rider_wallets_rider   ON rider_wallets(rider_id);
CREATE INDEX IF NOT EXISTS idx_rider_wallets_balance ON rider_wallets(cash_balance);

-- ─────────────────────────────────────────────────────────────────────────────
-- Rider wallet transaction log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rider_wallet_transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    wallet_id           UUID NOT NULL REFERENCES rider_wallets(id),
    transaction_type    VARCHAR(30) NOT NULL
                        CHECK (transaction_type IN (
                            'cash_topup',           -- Rider adds money to wallet
                            'ride_payment',         -- Paid for ride using wallet
                            'refund',               -- Ride cancelled, money returned
                            'coin_earn',            -- Coins earned from ride
                            'coin_redeem',          -- Coins used for discount
                            'coin_credit',          -- Admin credits coins
                            'coin_debit',           -- Admin debits coins
                            'cash_credit',          -- Admin credits cash
                            'cash_debit',           -- Admin debits cash
                            'promo_credit',         -- Promo/cashback credit
                            'cashback'              -- Cashback on ride
                        )),
    cash_amount         DECIMAL(12,2) NOT NULL DEFAULT 0,  -- Cash movement (+ credit, - debit)
    coin_amount         INTEGER NOT NULL DEFAULT 0,         -- Coin movement (+ earn, - redeem)
    cash_balance_before DECIMAL(12,2) NOT NULL,
    cash_balance_after  DECIMAL(12,2) NOT NULL,
    coin_balance_before INTEGER NOT NULL,
    coin_balance_after  INTEGER NOT NULL,
    ride_id             UUID REFERENCES rides(id),
    payment_method      VARCHAR(30),               -- For topups: upi, card, netbanking
    gateway_reference   VARCHAR(200),
    discount_inr        DECIMAL(10,2),             -- For coin_redeem: discount applied
    original_fare_inr   DECIMAL(10,2),             -- For ride_payment: fare before discount
    final_fare_inr      DECIMAL(10,2),             -- For ride_payment: fare after discount
    reason              TEXT,
    created_by          VARCHAR(100) DEFAULT 'system',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rider_wallet_txn_rider ON rider_wallet_transactions(rider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rider_wallet_txn_ride  ON rider_wallet_transactions(ride_id) WHERE ride_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rider_wallet_txn_type  ON rider_wallet_transactions(transaction_type, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Rider topup requests (tracks payment gateway lifecycle)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rider_topup_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id            UUID NOT NULL REFERENCES riders(id),
    amount              DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    payment_method      VARCHAR(30) NOT NULL
                        CHECK (payment_method IN ('upi', 'card', 'netbanking', 'neft', 'imps')),
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','completed','failed','refunded')),
    gateway_order_id    VARCHAR(200),
    gateway_reference   VARCHAR(200),
    gateway_response    JSONB,
    initiated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    failed_reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_rider_topup_rider  ON rider_topup_requests(rider_id, initiated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rider_topup_status ON rider_topup_requests(status) WHERE status IN ('pending','processing');

-- ─────────────────────────────────────────────────────────────────────────────
-- Rider wallet spend limits & KYC tiers
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rider_wallet_kyc_tiers (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tier_name               VARCHAR(30) UNIQUE NOT NULL,   -- basic, kyc_verified, full_kyc
    max_balance             DECIMAL(12,2) NOT NULL,
    daily_topup_limit       DECIMAL(10,2) NOT NULL,
    monthly_topup_limit     DECIMAL(12,2) NOT NULL,
    per_transaction_limit   DECIMAL(10,2) NOT NULL,
    requires_documents      BOOLEAN NOT NULL DEFAULT false,
    description             TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default KYC tiers
INSERT INTO rider_wallet_kyc_tiers (tier_name, max_balance, daily_topup_limit, monthly_topup_limit, per_transaction_limit, requires_documents, description)
VALUES
    ('basic',        10000,  2000,  20000, 2000,  false, 'Default tier — no KYC required'),
    ('kyc_verified', 50000,  10000, 100000, 10000, true,  'PAN verified — higher limits'),
    ('full_kyc',     200000, 50000, 500000, 50000, true,  'Aadhaar + PAN verified — full limits')
ON CONFLICT (tier_name) DO NOTHING;

-- Rider Cash Wallet: 4 tables total
