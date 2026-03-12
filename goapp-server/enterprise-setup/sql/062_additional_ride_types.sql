-- ============================================================
-- GoApp Enterprise Schema: 062 - Additional Ride Types
-- Adds Scooty and Women Scooty to the backend ride type catalog.
-- ============================================================

UPDATE vehicle_types
   SET sort_order = CASE name
     WHEN 'bike' THEN 1
     WHEN 'auto' THEN 4
     WHEN 'mini' THEN 5
     WHEN 'sedan' THEN 6
     WHEN 'suv' THEN 7
     WHEN 'premium' THEN 8
     ELSE sort_order
   END
 WHERE name IN ('bike', 'auto', 'mini', 'sedan', 'suv', 'premium');

INSERT INTO vehicle_types
    (name, display_name, category, base_fare, per_km_rate, per_min_rate, min_fare, commission_pct, max_passengers, sort_order, is_active, description)
VALUES
    ('scooty',        'Scooty',        'bike', 22, 6.5, 1.0, 42, 0.20, 1, 2, true, 'Smooth city rides'),
    ('women_scooty',  'Women Scooty',  'bike', 24, 6.5, 1.1, 45, 0.20, 1, 3, true, 'Women only, driven by women')
ON CONFLICT (name) DO UPDATE SET
    display_name   = EXCLUDED.display_name,
    category       = EXCLUDED.category,
    base_fare      = EXCLUDED.base_fare,
    per_km_rate    = EXCLUDED.per_km_rate,
    per_min_rate   = EXCLUDED.per_min_rate,
    min_fare       = EXCLUDED.min_fare,
    commission_pct = EXCLUDED.commission_pct,
    max_passengers = EXCLUDED.max_passengers,
    sort_order     = EXCLUDED.sort_order,
    is_active      = EXCLUDED.is_active,
    description    = EXCLUDED.description;
