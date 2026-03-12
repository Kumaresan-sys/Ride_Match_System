-- ============================================================
-- GoApp Enterprise Schema: 061 - Zone Vehicle Type Availability
-- Per-zone ride type enable/disable controls for rider discovery
-- and ride request enforcement.
-- ============================================================

CREATE TABLE IF NOT EXISTS zone_vehicle_type_availability (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id           UUID NOT NULL,
    vehicle_type_id   UUID NOT NULL,
    vehicle_type_name VARCHAR(80) NOT NULL,
    is_enabled        BOOLEAN NOT NULL DEFAULT true,
    updated_by        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_vehicle_type_availability_zone_vehicle
    ON zone_vehicle_type_availability (zone_id, vehicle_type_id);

CREATE INDEX IF NOT EXISTS idx_zone_vehicle_type_availability_zone
    ON zone_vehicle_type_availability (zone_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_zone_vehicle_type_availability_vehicle_name
    ON zone_vehicle_type_availability (vehicle_type_name);

CREATE OR REPLACE FUNCTION update_zone_vehicle_type_availability_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zone_vehicle_type_availability_updated_at
    ON zone_vehicle_type_availability;

CREATE TRIGGER zone_vehicle_type_availability_updated_at
    BEFORE UPDATE ON zone_vehicle_type_availability
    FOR EACH ROW EXECUTE FUNCTION update_zone_vehicle_type_availability_timestamp();
