CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS zone_vehicle_type_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id UUID NOT NULL REFERENCES zone_restrictions(id) ON DELETE CASCADE,
  vehicle_type_id UUID NOT NULL,
  vehicle_type_name TEXT NOT NULL,
  base_fare NUMERIC(10,2) NOT NULL,
  per_km_rate NUMERIC(10,2) NOT NULL,
  per_min_rate NUMERIC(10,2) NOT NULL,
  min_fare NUMERIC(10,2) NOT NULL,
  commission_pct NUMERIC(6,4),
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT zone_vehicle_type_pricing_unique UNIQUE (zone_id, vehicle_type_id)
);

CREATE INDEX IF NOT EXISTS idx_zone_vehicle_type_pricing_zone_id
  ON zone_vehicle_type_pricing(zone_id);

CREATE INDEX IF NOT EXISTS idx_zone_vehicle_type_pricing_vehicle_type_name
  ON zone_vehicle_type_pricing(vehicle_type_name);
