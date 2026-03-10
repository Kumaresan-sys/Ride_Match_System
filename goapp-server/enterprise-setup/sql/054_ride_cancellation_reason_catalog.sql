-- ============================================================
-- 054_ride_cancellation_reason_catalog.sql
-- Backend-owned cancellation reason catalog + FK linkage
-- ============================================================

CREATE TABLE IF NOT EXISTS ride_cancellation_reasons (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_type          VARCHAR(20) NOT NULL
                        CHECK (actor_type IN ('rider','driver','system')),
    code                VARCHAR(64) NOT NULL,
    title               VARCHAR(140) NOT NULL,
    description         TEXT,
    requires_note       BOOLEAN NOT NULL DEFAULT false,
    is_user_selectable  BOOLEAN NOT NULL DEFAULT true,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ride_cancellation_reasons_actor_code UNIQUE (actor_type, code)
);

CREATE INDEX IF NOT EXISTS idx_ride_cancellation_reasons_actor_active
  ON ride_cancellation_reasons (actor_type, is_active, sort_order, created_at);

ALTER TABLE ride_cancellations
  ADD COLUMN IF NOT EXISTS reason_catalog_id UUID REFERENCES ride_cancellation_reasons(id);

CREATE INDEX IF NOT EXISTS idx_ride_cancellations_reason_catalog
  ON ride_cancellations (reason_catalog_id);

INSERT INTO ride_cancellation_reasons
  (actor_type, code, title, description, requires_note, is_user_selectable, sort_order, is_active)
VALUES
  ('rider', 'WAIT_TIME_TOO_LONG', 'Wait time too long', 'Pickup wait time is too high for this trip.', false, true, 10, true),
  ('rider', 'DRIVER_TOO_FAR_AWAY', 'Driver too far away', 'Assigned driver is too far from the pickup point.', false, true, 20, true),
  ('rider', 'WRONG_PICKUP_LOCATION', 'Wrong pickup location selected', 'Pickup pin or address was selected incorrectly.', false, true, 30, true),
  ('rider', 'PRICE_NOT_REASONABLE', 'The price is not reasonable', 'Fare shown does not work for this trip.', false, true, 40, true),
  ('rider', 'WRONG_ADDRESS_SHOWN', 'Wrong address shown', 'The app showed the wrong address or destination.', false, true, 50, true),
  ('rider', 'CHANGE_OF_PLANS', 'My plan changed', 'Rider no longer needs this ride.', false, true, 60, true),
  ('rider', 'RIDER_OTHER', 'Other', 'Any other rider cancellation reason.', true, true, 70, true),
  ('driver', 'RIDER_NOT_RESPONDING', 'Rider is not responding', 'Rider could not be reached or did not appear.', false, true, 10, true),
  ('driver', 'PICKUP_UNSAFE', 'Pickup location is unsafe', 'Pickup point is unsafe or inaccessible.', false, true, 20, true),
  ('driver', 'VEHICLE_ISSUE', 'Vehicle issue', 'Driver has a vehicle issue and cannot continue.', false, true, 30, true),
  ('driver', 'TRAFFIC_OR_BREAKDOWN', 'Traffic or breakdown', 'Unexpected traffic or vehicle breakdown prevents pickup.', false, true, 40, true),
  ('driver', 'WRONG_ROUTE_OR_ZONE', 'Wrong route or zone', 'Trip route or service zone cannot be served.', false, true, 50, true),
  ('driver', 'DRIVER_OTHER', 'Other', 'Any other driver cancellation reason.', true, true, 60, true),
  ('system', 'NO_DRIVERS_IN_ZONE', 'No drivers found in your pickup zone', 'System could not find an eligible driver in the pickup zone.', false, false, 10, true)
ON CONFLICT (actor_type, code) DO UPDATE
SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  requires_note = EXCLUDED.requires_note,
  is_user_selectable = EXCLUDED.is_user_selectable,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
