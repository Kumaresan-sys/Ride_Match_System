-- ============================================================
-- GoApp Enterprise Schema: 025 - Driver Incentive Tasks
-- Domain: Admin-created driver quests & reward system (5 tables)
-- ============================================================

CREATE TABLE IF NOT EXISTS driver_incentive_tasks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_code           VARCHAR(30) UNIQUE NOT NULL,   -- e.g., TASK-1234-ABCD
    title               VARCHAR(200) NOT NULL,
    description         TEXT,
    type                VARCHAR(30) NOT NULL
                        CHECK (type IN ('trip_count','earnings','streak','peak_hour',
                                        'area_bonus','referral','rating')),
    target_value        DECIMAL(12,2) NOT NULL,        -- N trips / ₹X earnings / N stars
    reward_type         VARCHAR(20) NOT NULL DEFAULT 'cash'
                        CHECK (reward_type IN ('cash','coins','badge')),
    reward_amount       DECIMAL(10,2) NOT NULL DEFAULT 0,   -- ₹ for cash, 0 for badge
    reward_coins        INTEGER NOT NULL DEFAULT 0,
    vehicle_type        VARCHAR(30),                   -- NULL = all vehicle types
    city_region         VARCHAR(100),                  -- NULL = all regions
    status              VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('draft','active','paused','completed','expired')),
    rules               JSONB NOT NULL DEFAULT '{}',   -- Extra conditions: { minRating, minDistance, ... }
    budget_total        DECIMAL(14,2),                 -- NULL = unlimited budget
    budget_spent        DECIMAL(14,2) NOT NULL DEFAULT 0,
    enrolled_count      INTEGER NOT NULL DEFAULT 0,
    completed_count     INTEGER NOT NULL DEFAULT 0,
    start_date          TIMESTAMPTZ NOT NULL,
    end_date            TIMESTAMPTZ NOT NULL,
    created_by          VARCHAR(100) NOT NULL DEFAULT 'admin',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (start_date < end_date)
);

CREATE INDEX IF NOT EXISTS idx_incentive_tasks_status   ON driver_incentive_tasks(status, end_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_incentive_tasks_type     ON driver_incentive_tasks(type);
CREATE INDEX IF NOT EXISTS idx_incentive_tasks_created  ON driver_incentive_tasks(created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Driver enrollment & progress per task
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_task_progress (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    task_id             UUID NOT NULL REFERENCES driver_incentive_tasks(id),
    current_value       DECIMAL(12,2) NOT NULL DEFAULT 0,
    target_value        DECIMAL(12,2) NOT NULL,
    percent_complete    DECIMAL(5,2) GENERATED ALWAYS AS (
                            LEAST((current_value / NULLIF(target_value, 0)) * 100, 100)
                        ) STORED,
    status              VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                        CHECK (status IN ('in_progress','completed','failed','expired')),
    reward_claimed      BOOLEAN NOT NULL DEFAULT false,
    reward_credited_at  TIMESTAMPTZ,
    enrolled_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    claimed_at          TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(driver_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_progress_driver ON driver_task_progress(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_task_progress_task   ON driver_task_progress(task_id, current_value DESC);
CREATE INDEX IF NOT EXISTS idx_task_progress_claim  ON driver_task_progress(reward_claimed, status) WHERE status = 'completed' AND reward_claimed = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- Progress event log (each increment that contributed to task progress)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_task_progress_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    progress_id         UUID NOT NULL REFERENCES driver_task_progress(id),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    task_id             UUID NOT NULL REFERENCES driver_incentive_tasks(id),
    increment_value     DECIMAL(12,2) NOT NULL,
    value_after         DECIMAL(12,2) NOT NULL,
    ride_id             UUID REFERENCES rides(id),
    source_event        VARCHAR(50),             -- ride_completed, referral_joined, etc.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_progress_log_driver ON driver_task_progress_log(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_progress_log_task   ON driver_task_progress_log(task_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Reward disbursement records
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incentive_reward_disbursements (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    task_id             UUID NOT NULL REFERENCES driver_incentive_tasks(id),
    progress_id         UUID NOT NULL REFERENCES driver_task_progress(id),
    reward_type         VARCHAR(20) NOT NULL,
    reward_amount       DECIMAL(10,2) NOT NULL DEFAULT 0,
    reward_coins        INTEGER NOT NULL DEFAULT 0,
    wallet_transaction_id UUID REFERENCES driver_wallet_transactions(id),
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','completed','failed')),
    disbursed_at        TIMESTAMPTZ,
    failed_reason       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reward_disbursements_driver ON incentive_reward_disbursements(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_disbursements_status ON incentive_reward_disbursements(status) WHERE status IN ('pending','processing');

-- ─────────────────────────────────────────────────────────────────────────────
-- Task leaderboard snapshots (cached periodically)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS incentive_leaderboard (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id             UUID NOT NULL REFERENCES driver_incentive_tasks(id),
    driver_id           UUID NOT NULL REFERENCES drivers(id),
    rank                INTEGER NOT NULL,
    current_value       DECIMAL(12,2) NOT NULL,
    target_value        DECIMAL(12,2) NOT NULL,
    snapshot_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(task_id, driver_id, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_task ON incentive_leaderboard(task_id, rank, snapshot_at DESC);

-- Driver Incentive Tasks: 5 tables total
