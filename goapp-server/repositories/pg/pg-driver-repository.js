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
         dup.phone_number                                           AS "phoneNumber",
         COALESCE(dup.onboarding_status, d.onboarding_status)       AS status,
         d.is_eligible,
         d.home_city,
         COALESCE(dup.vehicle_number, v.license_plate)              AS "vehicleNumber",
         COALESCE(dup.vehicle_type, vt.name)                        AS "vehicleType",
         dup.avatar_url                                             AS "avatarUrl",
         COALESCE(dup.completed_rides_count, 0)                     AS "completedRides",
         COALESCE(dup.average_rating, 5.0)                          AS rating,
         COALESCE(dup.acceptance_rate, 1.0)                         AS "acceptanceRate",
         COALESCE(dup.completion_rate, 1.0)                         AS "completionRate"
       FROM drivers d
       LEFT JOIN driver_user_projection dup ON dup.driver_id = d.id
       LEFT JOIN vehicles v       ON v.driver_id = d.id AND v.is_primary = true
       LEFT JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
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
         dup.phone_number                                           AS "phoneNumber",
         COALESCE(dup.onboarding_status, d.onboarding_status)       AS status,
         d.is_eligible,
         COALESCE(dup.vehicle_number, v.license_plate)              AS "vehicleNumber",
         COALESCE(dup.vehicle_type, vt.name)                        AS "vehicleType",
         dup.avatar_url                                             AS "avatarUrl",
         COALESCE(dup.completed_rides_count, 0)                     AS "completedRides",
         COALESCE(dup.average_rating, 5.0)                          AS rating,
         COALESCE(dup.acceptance_rate, 1.0)                         AS "acceptanceRate",
         COALESCE(dup.completion_rate, 1.0)                         AS "completionRate"
       FROM drivers d
       LEFT JOIN driver_user_projection dup ON dup.driver_id = d.id
       LEFT JOIN vehicles v       ON v.driver_id = d.id AND v.is_primary = true
       LEFT JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
       WHERE d.id::text = $1 OR dup.user_id::text = $1
       LIMIT 1`,
      [driverId]
    );
    return rows[0] || null;
  }

  async updateDriverStatus(driverId, status) {
    // status here maps to onboarding_status or is_eligible flag
    const normalizedStatus = String(status || '').trim().toLowerCase();
    const isAvailabilityStatus = ['online', 'offline', 'busy', 'on_trip', 'on_ride'].includes(normalizedStatus);

    if (isAvailabilityStatus) {
      const isAvailable = normalizedStatus === 'online';
      const availabilityStatus = isAvailable ? 'active' : normalizedStatus;

      await domainDb.query('drivers', 
        `INSERT INTO driver_availability (driver_id, is_available, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (driver_id)
         DO UPDATE SET is_available = $2, updated_at = NOW()`,
        [driverId, isAvailable]
      ).catch(() => {}); // non-fatal if table doesn't exist yet

      await domainDb.query(
        'drivers',
        `UPDATE driver_user_projection
         SET status = $2,
             updated_at = NOW()
         WHERE driver_id::text = $1 OR user_id::text = $1`,
        [driverId, availabilityStatus]
      ).catch(() => {});
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
      `UPDATE driver_user_projection
       SET average_rating = $2,
           updated_at = NOW()
       WHERE driver_id::text = $1 OR user_id::text = $1`,
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
