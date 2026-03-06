-- ============================================================
-- GoApp Enterprise Schema: 023 - Driver Wallet
-- Domain: Driver Wallet Management (4 tables)
-- Rule: Driver must maintain ≥ ₹300 to receive ride requests
-- ============================================================

CREATE TABLE IF NOT EXISTS driver_wallets (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id               UUID NOT NULL UNIQUE REFERENCES drivers(id) ON DELETE CASCADE,
    balance                 DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    min_balance_required    DECIMAL(10,2) NOT NULL DEFAULT 300.00,
    can_receive_rides       BOOLEAN GENERATED ALWAYS AS (balance >= min_balance_required) STORED,
    total_earned            DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    total_deducted          DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    total_incentives        DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    last_recharge_at        TIMESTAMPTZ,
    last_deduction_at       TIMESTAMPTZ,
    is_frozen               BOOLEAN NOT NULL DEFAULT false,   -- Admin can freeze wallet
    frozen_reason           TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_wallets_driver   ON driver_wallets(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_wallets_balance  ON driver_wallets(balance);
CREATE INDEX IF NOT EXISTS idx_driver_wallets_eligible ON driver_wallets(can_receive_rides) WHERE can_receive_rides = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- Driver wallet transaction log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_wallet_transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    wallet_id           UUID NOT NULL REFERENCES driver_wallets(id),
    transaction_type    VARCHAR(30) NOT NULL
                        CHECK (transaction_type IN (
                            'recharge',             -- Driver adds money
                            'commission_deduction', -- Platform deducts commission
                            'ride_earnings',        -- Ride fare share credited
                            'incentive_credit',     -- Bonus/incentive credited
                            'refund',               -- Refund from platform
                            'admin_credit',         -- Admin manually credits
                            'admin_debit',          -- Admin manually debits
                            'payout',               -- Driver withdraws to bank
                            'penalty'               -- Deduction for policy violation
                        )),
    amount              DECIMAL(12,2) NOT NULL,   -- positive = credit, negative = debit
    balance_before      DECIMAL(12,2) NOT NULL,
    balance_after       DECIMAL(12,2) NOT NULL,
    ride_id             UUID REFERENCES rides(id),
    incentive_id        UUID,                     -- References driver_incentive_tasks
    payment_method      VARCHAR(30),              -- upi, card, netbanking, neft, imps
    gateway_reference   VARCHAR(200),
    reason              TEXT,
    created_by          VARCHAR(100) DEFAULT 'system',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_wallet_txn_driver  ON driver_wallet_transactions(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_wallet_txn_ride    ON driver_wallet_transactions(ride_id) WHERE ride_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_driver_wallet_txn_type    ON driver_wallet_transactions(transaction_type);

-- ─────────────────────────────────────────────────────────────────────────────
-- Driver recharge requests (tracks topup lifecycle)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_recharge_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    amount              DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    payment_method      VARCHAR(30) NOT NULL
                        CHECK (payment_method IN ('upi', 'card', 'netbanking', 'neft', 'imps', 'cash')),
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','completed','failed','refunded')),
    gateway_order_id    VARCHAR(200),
    gateway_reference   VARCHAR(200),
    gateway_response    JSONB,
    initiated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    failed_reason       TEXT
);

CREATE INDEX IF NOT EXISTS idx_driver_recharge_driver ON driver_recharge_requests(driver_id, initiated_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_recharge_status ON driver_recharge_requests(status) WHERE status IN ('pending','processing');

-- ─────────────────────────────────────────────────────────────────────────────
-- Driver wallet low-balance alerts log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_wallet_alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id       UUID NOT NULL REFERENCES drivers(id),
    alert_type      VARCHAR(30) NOT NULL
                    CHECK (alert_type IN ('low_balance','blocked','unblocked','frozen','unfrozen')),
    balance_at_time DECIMAL(12,2) NOT NULL,
    message         TEXT,
    notified_via    VARCHAR(20)[],    -- push, sms, email
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_wallet_alerts ON driver_wallet_alerts(driver_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-update updated_at on driver_wallets
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_driver_wallet_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER driver_wallet_updated_at
    BEFORE UPDATE ON driver_wallets
    FOR EACH ROW EXECUTE FUNCTION update_driver_wallet_timestamp();

-- Driver Wallet: 4 tables total
