// PostgreSQL / PostGIS-backed Location Repository
// Tables: driver_locations (time-series), ride_live_locations
// Used by location-service.js when DB_BACKEND=pg
//
// Architecture note:
//   Redis GEO remains the primary store for real-time matching queries (<10ms).
//   PostGIS is the write-through persistence layer and the fallback for
//   GEORADIUS queries when Redis is unavailable.

'use strict';

const domainDb = require('../../infra/db/domain-db');

// Approximate H3 grid cell using lat/lng until h3-js is added.
// Replace with: const h3 = require('h3-js'); h3.latLngToCell(lat,lng,8)
function approxH3(lat, lng) {
  const res = 8; // ~0.46 km cells
  return `gh:${res}:${Math.floor(lat * 100)}:${Math.floor(lng * 100)}`;
}

// Resolve driver external string ID (e.g. "DRV-ABC123" or a UUID) → drivers.id UUID
async function resolveDriverDbId(driverId) {
  const { rows } = await domainDb.query('drivers', 
    `SELECT driver_id AS id
     FROM driver_user_projection
     WHERE driver_id::text = $1
        OR user_id::text = $1
     LIMIT 1`,
    [driverId]
  );
  return rows[0]?.id || null;
}

class PgLocationRepository {
  // ─── Upsert current driver position ───────────────────────────────────────
  // Inserts a new row each call (time-series; use a separate current_location
  // table or Redis for point-in-time queries).

  async recordLocation(driverId, { lat, lng, speed, heading, source = 'gps' }) {
    const driverDbId = await resolveDriverDbId(driverId);
    if (!driverDbId) return; // driver not yet onboarded to DB

    const h3Index = approxH3(lat, lng);

    await domainDb.query('drivers', 
      `INSERT INTO driver_locations
         (driver_id, location, h3_index, speed_kmh, heading, source)
       VALUES (
         $1,
         ST_SetSRID(ST_MakePoint($3, $2), 4326),
         $4, $5, $6, $7
       )`,
      [driverDbId, lat, lng, h3Index, speed || 0, heading || 0, source]
    ).catch(() => {}); // non-fatal — Redis is the real-time source
  }

  // ─── PostGIS spatial search ───────────────────────────────────────────────
  // Finds active drivers within radiusKm using ST_DWithin on geography type.
  // Only used as a fallback when Redis GEO is unavailable.

  async findNearbyDrivers(lat, lng, radiusKm, maxCount = 10) {
    const radiusM = radiusKm * 1000;

    const { rows } = await domainDb.query('drivers', 
      `SELECT DISTINCT ON (dl.driver_id)
         dl.driver_id::text                                  AS "driverId",
         ST_Y(dl.location::geometry)                        AS lat,
         ST_X(dl.location::geometry)                        AS lng,
         ST_Distance(
           dl.location::geography,
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
         ) / 1000                                           AS "distanceKm",
         dl.speed_kmh                                       AS speed,
         dl.heading,
         dl.recorded_at                                     AS "lastUpdate"
       FROM driver_locations dl
       LEFT JOIN driver_user_projection dup ON dup.driver_id = dl.driver_id
       WHERE COALESCE(dup.onboarding_status, 'approved') = 'approved'
         AND dl.recorded_at > NOW() - INTERVAL '30 seconds'
         AND ST_DWithin(
           dl.location::geography,
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
           $3
         )
       ORDER BY dl.driver_id, dl.recorded_at DESC, "distanceKm" ASC
       LIMIT $4`,
      [lat, lng, radiusM, maxCount]
    );
    return rows;
  }

  // ─── Ride live location ───────────────────────────────────────────────────

  async recordRideLiveLocation(rideId, driverId, { lat, lng, speed, heading }) {
    const driverDbId = await resolveDriverDbId(driverId);
    if (!driverDbId) return;

    await domainDb.query('drivers', 
      `INSERT INTO ride_live_locations (ride_id, driver_id, location, speed_kmh, heading)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326), $5, $6)`,
      [rideId, driverDbId, lat, lng, speed || 0, heading || 0]
    ).catch(() => {});
  }

  // ─── History ──────────────────────────────────────────────────────────────

  async getDriverLocationHistory(driverId, limitHours = 1) {
    const driverDbId = await resolveDriverDbId(driverId);
    if (!driverDbId) return [];

    const { rows } = await domainDb.query('drivers', 
      `SELECT
         ST_Y(location::geometry) AS lat,
         ST_X(location::geometry) AS lng,
         speed_kmh AS speed, heading,
         EXTRACT(EPOCH FROM recorded_at) * 1000 AS "recordedAt"
       FROM driver_locations
       WHERE driver_id = $1
         AND recorded_at > NOW() - ($2 || ' hours')::interval
       ORDER BY recorded_at DESC`,
      [driverDbId, limitHours]
    );
    return rows;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getStats() {
    const { rows } = await domainDb.query('drivers', 
      `SELECT COUNT(DISTINCT driver_id)::int AS "activeDrivers"
       FROM driver_locations
       WHERE recorded_at > NOW() - INTERVAL '30 seconds'`
    );
    return { postgisActiveDrivers: rows[0]?.activeDrivers || 0 };
  }
}

module.exports = new PgLocationRepository();
