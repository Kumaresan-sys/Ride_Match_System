// PostgreSQL-backed Driver & Rider Repository
// Tables: drivers, riders, users, user_profiles, vehicles, vehicle_types
// Used by mock-db.js when DB_BACKEND=pg

'use strict';

const domainDb = require('../../infra/db/domain-db');

class PgDriverRepository {
  // ─── Drivers ──────────────────────────────────────────────────────────────

  async listDrivers(limit = 100) {
    const { rows } = await domainDb.query('drivers', 
      `SELECT
         d.id                                                       AS "driverId",
         dup.user_id                                                AS "userId",
         COALESCE(dup.display_name, dup.phone_number, d.id::text)  AS name,
         d.onboarding_status                                        AS status,
         d.is_eligible,
         d.home_city,
         v.vehicle_number                                           AS "vehicleNumber",
         vt.name                                                    AS "vehicleType",
         COALESCE(dr.average_rating, 5.0)                          AS rating,
         COALESCE(dr.acceptance_rate, 1.0)                         AS "acceptanceRate",
         COALESCE(dr.completion_rate, 1.0)                         AS "completionRate"
       FROM drivers d
       LEFT JOIN driver_user_projection dup ON dup.driver_id = d.id
       LEFT JOIN vehicles v       ON v.driver_id = d.id AND v.is_primary = true
       LEFT JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
       LEFT JOIN driver_ratings dr ON dr.driver_id = d.id
       WHERE d.onboarding_status = 'approved'
         AND COALESCE(dup.status, 'active') <> 'deleted'
       ORDER BY d.created_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  }

  async getDriver(driverId) {
    const { rows } = await domainDb.query('drivers', 
      `SELECT
         d.id                                                       AS "driverId",
         dup.user_id                                                AS "userId",
         COALESCE(dup.display_name, dup.phone_number, d.id::text)  AS name,
         d.onboarding_status                                        AS status,
         d.is_eligible,
         v.vehicle_number                                           AS "vehicleNumber",
         vt.name                                                    AS "vehicleType",
         COALESCE(dr.average_rating, 5.0)                          AS rating,
         COALESCE(dr.acceptance_rate, 1.0)                         AS "acceptanceRate",
         COALESCE(dr.completion_rate, 1.0)                         AS "completionRate"
       FROM drivers d
       LEFT JOIN driver_user_projection dup ON dup.driver_id = d.id
       LEFT JOIN vehicles v       ON v.driver_id = d.id AND v.is_primary = true
       LEFT JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
       LEFT JOIN driver_ratings dr ON dr.driver_id = d.id
       WHERE d.id::text = $1 OR dup.user_id::text = $1
       LIMIT 1`,
      [driverId]
    );
    return rows[0] || null;
  }

  async updateDriverStatus(driverId, status) {
    // status here maps to onboarding_status or is_eligible flag
    const isAvailabilityStatus = ['online', 'offline', 'busy'].includes(status);

    if (isAvailabilityStatus) {
      // Track availability via driver_availability table if it exists, else no-op
      await domainDb.query('drivers', 
        `INSERT INTO driver_availability (driver_id, is_online, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (driver_id)
         DO UPDATE SET is_online = $2, updated_at = NOW()`,
        [driverId, status === 'online']
      ).catch(() => {}); // non-fatal if table doesn't exist yet
    } else {
      await domainDb.query('drivers', 
        `UPDATE drivers SET onboarding_status = $2, updated_at = NOW()
         WHERE id::text = $1`,
        [driverId, status]
      );
    }
  }

  async updateDriverRating(driverId, newRating) {
    await domainDb.query('drivers', 
      `INSERT INTO driver_ratings (driver_id, average_rating)
       VALUES ($1, $2)
       ON CONFLICT (driver_id)
       DO UPDATE SET average_rating = $2, updated_at = NOW()`,
      [driverId, newRating]
    ).catch(() => {}); // non-fatal if table doesn't exist yet
  }

  // ─── Riders ───────────────────────────────────────────────────────────────

  async listRiders(limit = 100) {
    const { rows } = await domainDb.query('drivers', 
      `SELECT
         r.rider_id                                                  AS "riderId",
         r.user_id                                                   AS "userId",
         COALESCE(r.display_name, r.phone_number, r.user_id::text)  AS name,
         r.status,
         r.total_rides                                               AS "totalRides",
         r.lifetime_spend                                            AS "lifetimeSpend",
         r.rider_tier                                                AS "riderTier"
       FROM rider_user_projection r
       WHERE COALESCE(r.status, 'active') <> 'deleted'
       ORDER BY r.updated_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  }

  async getRider(riderId) {
    const { rows } = await domainDb.query('drivers', 
      `SELECT
         r.rider_id                                                  AS "riderId",
         r.user_id                                                   AS "userId",
         COALESCE(r.display_name, r.phone_number, r.user_id::text)  AS name,
         r.status,
         r.total_rides                                               AS "totalRides"
       FROM rider_user_projection r
       WHERE r.rider_id::text = $1 OR r.user_id::text = $1
       LIMIT 1`,
      [riderId]
    );
    return rows[0] || null;
  }

  async updateRiderRating(riderId, newRating) {
    await domainDb.query('drivers', 
      `INSERT INTO rider_ratings (rider_id, rating, ride_id, driver_id)
       VALUES ($1, $2, gen_random_uuid(), gen_random_uuid())
       ON CONFLICT DO NOTHING`,
      [riderId, newRating]
    ).catch(() => {});
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getStats() {
    const [{ rows: dr }, { rows: rr }] = await Promise.all([
      domainDb.query('drivers', `SELECT COUNT(*)::int AS cnt FROM drivers WHERE onboarding_status = 'approved'`),
      domainDb.query('drivers', `SELECT COUNT(*)::int AS cnt FROM rider_user_projection`),
    ]);
    return {
      driverRecords: dr[0].cnt,
      riderRecords:  rr[0].cnt,
    };
  }
}

module.exports = new PgDriverRepository();
