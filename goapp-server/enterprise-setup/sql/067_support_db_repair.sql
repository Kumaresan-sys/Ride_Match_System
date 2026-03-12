-- 067_support_db_repair.sql
-- Auditable reconciliation step for existing support_db environments.
-- This migration is intentionally idempotent and can be re-applied safely.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS support_trip_issue_groups (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title                VARCHAR(200) NOT NULL,
    description          TEXT,
    backend_category     VARCHAR(64) NOT NULL,
    show_driver_details  BOOLEAN NOT NULL DEFAULT false,
    sort_order           INTEGER NOT NULL DEFAULT 0,
    is_active            BOOLEAN NOT NULL DEFAULT true,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT support_trip_issue_groups_backend_category_check
      CHECK (backend_category IN (
        'fare_issue',
        'driver_vehicle_issue',
        'payment_wallet_issue',
        'coins_issue',
        'referral_issue',
        'app_issue',
        'account_deactivation',
        'general_support',
        'ride_related_issue'
      ))
);

CREATE INDEX IF NOT EXISTS idx_support_trip_issue_groups_active_order
  ON support_trip_issue_groups(is_active, sort_order, created_at);

CREATE TABLE IF NOT EXISTS support_trip_issue_subissues (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id             UUID NOT NULL REFERENCES support_trip_issue_groups(id) ON DELETE CASCADE,
    title                VARCHAR(240) NOT NULL,
    description          TEXT,
    sort_order           INTEGER NOT NULL DEFAULT 0,
    is_active            BOOLEAN NOT NULL DEFAULT true,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_trip_issue_subissues_group_order
  ON support_trip_issue_subissues(group_id, is_active, sort_order, created_at);

CREATE OR REPLACE FUNCTION update_support_trip_issue_catalog_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_trip_issue_groups_updated_at
  ON support_trip_issue_groups;

CREATE TRIGGER support_trip_issue_groups_updated_at
  BEFORE UPDATE ON support_trip_issue_groups
  FOR EACH ROW EXECUTE FUNCTION update_support_trip_issue_catalog_timestamp();

DROP TRIGGER IF EXISTS support_trip_issue_subissues_updated_at
  ON support_trip_issue_subissues;

CREATE TRIGGER support_trip_issue_subissues_updated_at
  BEFORE UPDATE ON support_trip_issue_subissues
  FOR EACH ROW EXECUTE FUNCTION update_support_trip_issue_catalog_timestamp();

INSERT INTO support_trip_issue_groups (
    title,
    description,
    backend_category,
    show_driver_details,
    sort_order,
    is_active
)
SELECT *
FROM (
    VALUES
      ('Driver behavior', 'Issues related to driver conduct during a completed ride.', 'driver_vehicle_issue', true, 10, true),
      ('Incorrect fare', 'Fare disputes and billing concerns tied to a completed ride.', 'fare_issue', false, 20, true),
      ('Route issue', 'Issues related to route choice, navigation, or detours.', 'ride_related_issue', false, 30, true),
      ('Safety concern', 'Unsafe rider experience or dangerous driving behavior during the ride.', 'driver_vehicle_issue', true, 40, true),
      ('Pickup issue', 'Problems related to driver arrival or pickup accuracy.', 'ride_related_issue', false, 50, true),
      ('Cancellation issue', 'Problems caused by avoidable or repeated cancellations.', 'ride_related_issue', false, 60, true),
      ('Payment issue', 'Problems related to payment collection, deductions, or transaction state.', 'payment_wallet_issue', false, 70, true),
      ('App issue', 'Problems caused by app errors, crashes, or incorrect ride-related UI.', 'app_issue', false, 80, true)
) AS seed(title, description, backend_category, show_driver_details, sort_order, is_active)
WHERE NOT EXISTS (
    SELECT 1
    FROM support_trip_issue_groups existing
    WHERE existing.title = seed.title
);

INSERT INTO support_trip_issue_subissues (group_id, title, description, sort_order, is_active)
SELECT group_id, title, description, sort_order, is_active
FROM (
    SELECT id AS group_id, 'Driver was rude or unprofessional' AS title, 'Behavioral misconduct during the ride.' AS description, 10 AS sort_order, true AS is_active
    FROM support_trip_issue_groups
    WHERE title = 'Driver behavior'
    UNION ALL
    SELECT id, 'Driver ignored my instructions', 'Driver did not follow pickup/drop or rider guidance.', 20, true
    FROM support_trip_issue_groups
    WHERE title = 'Driver behavior'
    UNION ALL
    SELECT id, 'Driver behavior made me uncomfortable', 'Rider felt unsafe or harassed by the driver.', 30, true
    FROM support_trip_issue_groups
    WHERE title = 'Driver behavior'
    UNION ALL
    SELECT id, 'Charged more than the estimated fare', 'Final fare exceeded rider expectation.', 10, true
    FROM support_trip_issue_groups
    WHERE title = 'Incorrect fare'
    UNION ALL
    SELECT id, 'Charged a cancellation fee', 'Unexpected cancellation charge on the completed/cancelled trip.', 20, true
    FROM support_trip_issue_groups
    WHERE title = 'Incorrect fare'
    UNION ALL
    SELECT id, 'Billing related issue', 'Trip fare contains a billing mismatch.', 30, true
    FROM support_trip_issue_groups
    WHERE title = 'Incorrect fare'
    UNION ALL
    SELECT id, 'Inefficient path taken', 'Driver took a longer-than-expected route.', 10, true
    FROM support_trip_issue_groups
    WHERE title = 'Route issue'
    UNION ALL
    SELECT id, 'Missed turn or destination', 'Route did not reach the requested destination correctly.', 20, true
    FROM support_trip_issue_groups
    WHERE title = 'Route issue'
    UNION ALL
    SELECT id, 'Unsafe driving area', 'Driver took an unsafe or unsuitable road.', 30, true
    FROM support_trip_issue_groups
    WHERE title = 'Route issue'
    UNION ALL
    SELECT id, 'Unexpected stop or detour', 'Trip included an unexplained stop or unnecessary detour.', 40, true
    FROM support_trip_issue_groups
    WHERE title = 'Route issue'
    UNION ALL
    SELECT id, 'Driver was using phone while riding', 'Driver was distracted by phone use during the trip.', 10, true
    FROM support_trip_issue_groups
    WHERE title = 'Safety concern'
    UNION ALL
    SELECT id, 'Driver was speeding', 'Driver drove at an unsafe speed.', 20, true
    FROM support_trip_issue_groups
    WHERE title = 'Safety concern'
    UNION ALL
    SELECT id, 'Driver drove rashly', 'Driver handled the vehicle in an unsafe or reckless way.', 30, true
    FROM support_trip_issue_groups
    WHERE title = 'Safety concern'
    UNION ALL
    SELECT id, 'Driver did not reach pickup point', 'Driver never arrived at the expected pickup location.', 10, true
    FROM support_trip_issue_groups
    WHERE title = 'Pickup issue'
    UNION ALL
    SELECT id, 'Driver asked me to walk too far', 'Driver requested a pickup point that was unreasonably far away.', 20, true
    FROM support_trip_issue_groups
    WHERE title = 'Pickup issue'
    UNION ALL
    SELECT id, 'Pickup location was wrong in app', 'Pickup marker or address was incorrect in the app.', 30, true
    FROM support_trip_issue_groups
    WHERE title = 'Pickup issue'
    UNION ALL
    SELECT id, 'Driver asked me to cancel', 'Driver requested that I cancel the trip instead of proceeding.', 10, true
    FROM support_trip_issue_groups
    WHERE title = 'Cancellation issue'
    UNION ALL
    SELECT id, 'Cancelled without informing me', 'Trip was cancelled without any explanation or communication.', 20, true
    FROM support_trip_issue_groups
    WHERE title = 'Cancellation issue'
    UNION ALL
    SELECT id, 'Repeated driver cancellations', 'Multiple drivers cancelled the trip in succession.', 30, true
    FROM support_trip_issue_groups
    WHERE title = 'Cancellation issue'
    UNION ALL
    SELECT id, 'Payment marked failed but amount deducted', 'Money was debited even though the payment did not complete correctly.', 10, true
    FROM support_trip_issue_groups
    WHERE title = 'Payment issue'
    UNION ALL
    SELECT id, 'Charged twice for the same ride', 'The same ride payment was collected more than once.', 20, true
    FROM support_trip_issue_groups
    WHERE title = 'Payment issue'
    UNION ALL
    SELECT id, 'Cash payment mismatch', 'Collected cash amount does not match the trip amount shown in the app.', 30, true
    FROM support_trip_issue_groups
    WHERE title = 'Payment issue'
    UNION ALL
    SELECT id, 'App showed wrong ride status', 'The app displayed an incorrect ride stage or completion state.', 10, true
    FROM support_trip_issue_groups
    WHERE title = 'App issue'
    UNION ALL
    SELECT id, 'Trip details were missing in app', 'Important ride details were not shown after the trip.', 20, true
    FROM support_trip_issue_groups
    WHERE title = 'App issue'
    UNION ALL
    SELECT id, 'App froze or crashed during trip flow', 'The app became unresponsive or crashed during the ride journey.', 30, true
    FROM support_trip_issue_groups
    WHERE title = 'App issue'
) seeded
WHERE NOT EXISTS (
    SELECT 1
    FROM support_trip_issue_subissues existing
    WHERE existing.group_id = seeded.group_id
      AND existing.title = seeded.title
);
