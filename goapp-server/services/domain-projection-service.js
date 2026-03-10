'use strict';

const domainDb = require('../infra/db/domain-db');
const { logger } = require('../utils/logger');

class DomainProjectionService {
  constructor() {
    this._vehicleNumberExpr = null;
  }

  async _resolveVehicleNumberExpr() {
    if (this._vehicleNumberExpr) return this._vehicleNumberExpr;
    const { rows } = await domainDb.query(
      'drivers',
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'vehicles'
         AND column_name IN ('vehicle_number', 'registration_number', 'license_plate')`,
      [],
      { role: 'reader' }
    );
    const columns = new Set(rows.map((row) => row.column_name));
    if (columns.has('vehicle_number')) {
      this._vehicleNumberExpr = 'v.vehicle_number';
    } else if (columns.has('registration_number')) {
      this._vehicleNumberExpr = 'v.registration_number';
    } else if (columns.has('license_plate')) {
      this._vehicleNumberExpr = 'v.license_plate';
    } else {
      this._vehicleNumberExpr = 'NULL::text';
    }
    return this._vehicleNumberExpr;
  }

  async _fetchRiderByLookup(lookup) {
    const { rows } = await domainDb.query(
      'identity',
      `SELECT
         r.id AS rider_id,
         u.id AS user_id,
         COALESCE(up.display_name, CONCAT_WS(' ', up.first_name, up.last_name), u.phone_number) AS display_name,
         u.phone_number,
         u.status,
         COALESCE(r.total_rides, 0) AS total_rides,
         COALESCE(r.lifetime_spend, 0) AS lifetime_spend,
         COALESCE(r.rider_tier, 'standard') AS rider_tier
       FROM riders r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE (u.id::text = $1 OR r.id::text = $1)
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [lookup],
      { role: 'reader' }
    );
    return rows[0] || null;
  }

  async _fetchDriverByLookup(lookup) {
    const vehicleNumberExpr = await this._resolveVehicleNumberExpr();
    const { rows } = await domainDb.query(
      'drivers',
      `SELECT
         d.id AS driver_id,
         d.user_id,
         d.onboarding_status,
         d.is_eligible,
         d.home_city,
         ${vehicleNumberExpr} AS vehicle_number,
         vt.name AS vehicle_type,
         COALESCE((
           SELECT ROUND(AVG(r.rating)::numeric, 2)
           FROM driver_ratings r
           WHERE r.driver_id = d.id
         ), 5.0) AS average_rating,
         1.0::numeric AS acceptance_rate,
         1.0::numeric AS completion_rate
       FROM drivers d
       LEFT JOIN vehicles v ON v.driver_id = d.id AND v.is_primary = true
       LEFT JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
       WHERE d.id::text = $1 OR d.user_id::text = $1
       LIMIT 1`,
      [lookup],
      { role: 'reader' }
    );
    const driver = rows[0] || null;
    if (!driver) return null;

    const user = await domainDb.query(
      'identity',
      `SELECT
         u.id AS user_id,
         COALESCE(up.display_name, CONCAT_WS(' ', up.first_name, up.last_name), u.phone_number) AS display_name,
         u.phone_number,
         u.status
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE u.id = $1
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [driver.user_id],
      { role: 'reader' }
    );

    return {
      ...driver,
      user_id: driver.user_id,
      display_name: user.rows[0]?.display_name || null,
      phone_number: user.rows[0]?.phone_number || null,
      status: user.rows[0]?.status || 'active',
    };
  }

  async _upsertRiderProjection(domain, table, rider) {
    await domainDb.query(
      domain,
      `INSERT INTO ${table} (
         rider_id,
         user_id,
         display_name,
         phone_number,
         status,
         total_rides,
         lifetime_spend,
         rider_tier,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (rider_id)
       DO UPDATE SET
         user_id = EXCLUDED.user_id,
         display_name = EXCLUDED.display_name,
         phone_number = EXCLUDED.phone_number,
         status = EXCLUDED.status,
         total_rides = EXCLUDED.total_rides,
         lifetime_spend = EXCLUDED.lifetime_spend,
         rider_tier = EXCLUDED.rider_tier,
         updated_at = NOW()`,
      [
        rider.rider_id,
        rider.user_id,
        rider.display_name || null,
        rider.phone_number || null,
        rider.status || 'active',
        Number(rider.total_rides || 0),
        Number(rider.lifetime_spend || 0),
        rider.rider_tier || 'standard',
      ],
      { role: 'writer', strongRead: true }
    );
  }

  async _upsertDriverProjection(domain, table, driver) {
    await domainDb.query(
      domain,
      `INSERT INTO ${table} (
         driver_id,
         user_id,
         display_name,
         phone_number,
         status,
         onboarding_status,
         is_eligible,
         home_city,
         vehicle_number,
         vehicle_type,
         average_rating,
         acceptance_rate,
         completion_rate,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       ON CONFLICT (driver_id)
       DO UPDATE SET
         user_id = EXCLUDED.user_id,
         display_name = EXCLUDED.display_name,
         phone_number = EXCLUDED.phone_number,
         status = EXCLUDED.status,
         onboarding_status = EXCLUDED.onboarding_status,
         is_eligible = EXCLUDED.is_eligible,
         home_city = EXCLUDED.home_city,
         vehicle_number = EXCLUDED.vehicle_number,
         vehicle_type = EXCLUDED.vehicle_type,
         average_rating = EXCLUDED.average_rating,
         acceptance_rate = EXCLUDED.acceptance_rate,
         completion_rate = EXCLUDED.completion_rate,
         updated_at = NOW()`,
      [
        driver.driver_id,
        driver.user_id,
        driver.display_name || null,
        driver.phone_number || null,
        driver.status || 'active',
        driver.onboarding_status || null,
        driver.is_eligible,
        driver.home_city || null,
        driver.vehicle_number || null,
        driver.vehicle_type || null,
        Number(driver.average_rating || 5),
        Number(driver.acceptance_rate || 1),
        Number(driver.completion_rate || 1),
      ],
      { role: 'writer', strongRead: true }
    );
  }

  async _upsertAnalyticsRiderProjection(rider) {
    await domainDb.query(
      'analytics',
      `INSERT INTO analytics_rider_projection (rider_id, user_id, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (rider_id)
       DO UPDATE SET
         user_id = EXCLUDED.user_id,
         updated_at = NOW()`,
      [rider.rider_id, rider.user_id],
      { role: 'writer', strongRead: true }
    );
  }

  async syncRiderByUserId(userId) {
    return this.syncRiderByLookup(userId);
  }

  async syncRiderByLookup(lookup) {
    if (!lookup) return { synced: false, reason: 'missing_rider_lookup' };
    const rider = await this._fetchRiderByLookup(lookup);
    if (!rider) return { synced: false, reason: 'rider_not_found' };

    await Promise.all([
      this._upsertRiderProjection('rides', 'ride_rider_projection', rider),
      this._upsertRiderProjection('payments', 'payment_rider_projection', rider),
      this._upsertRiderProjection('drivers', 'rider_user_projection', rider),
      this._upsertAnalyticsRiderProjection(rider),
    ]);

    return {
      synced: true,
      type: 'rider',
      riderId: rider.rider_id,
      userId: rider.user_id,
    };
  }

  async syncDriverByLookup(lookup) {
    if (!lookup) return { synced: false, reason: 'missing_driver_lookup' };
    const driver = await this._fetchDriverByLookup(lookup);
    if (!driver) return { synced: false, reason: 'driver_not_found' };

    await Promise.all([
      this._upsertDriverProjection('rides', 'ride_driver_projection', driver),
      this._upsertDriverProjection('payments', 'payment_driver_projection', driver),
      this._upsertDriverProjection('drivers', 'driver_user_projection', driver),
    ]);

    return {
      synced: true,
      type: 'driver',
      driverId: driver.driver_id,
      userId: driver.user_id,
    };
  }

  async syncFromEvent(topic, payload = {}) {
    const tasks = [];

    const riderId = payload?.riderId || payload?.userId || null;
    const driverId = payload?.driverId || null;

    if (topic === 'ride_requested' || topic === 'ride_matched' || topic === 'wallet_updated' || topic === 'identity_profile_updated') {
      if (riderId) tasks.push(this.syncRiderByLookup(riderId));
    }

    if (topic === 'ride_matched' || topic === 'driver_profile_updated' || topic === 'payment_completed') {
      if (driverId) tasks.push(this.syncDriverByLookup(driverId));
    }

    if (topic === 'payment_completed') {
      if (payload?.userType === 'rider' && payload?.userId) {
        tasks.push(this.syncRiderByUserId(payload.userId));
      }
      if (payload?.userType === 'driver' && payload?.userId) {
        tasks.push(this.syncDriverByLookup(payload.userId));
      }
    }

    if (!tasks.length) return { synced: false, reason: 'no_projection_target' };

    const settled = await Promise.allSettled(tasks);
    const failures = settled.filter((item) => item.status === 'rejected');
    if (failures.length) {
      logger.warn('PROJECTION', `Projection sync completed with ${failures.length} failures for topic ${topic}`);
    }
    return {
      synced: failures.length < settled.length,
      attempted: settled.length,
      failures: failures.length,
    };
  }

  async backfill({ batchSize = 500 } = {}) {
    const safeBatch = Math.max(50, Math.min(Number(batchSize) || 500, 2000));
    let riderOffset = 0;
    let driverOffset = 0;
    let ridersSynced = 0;
    let driversSynced = 0;

    while (true) {
      const { rows } = await domainDb.query(
        'identity',
        `SELECT u.id AS user_id
         FROM riders r
         JOIN users u ON u.id = r.user_id
         WHERE u.deleted_at IS NULL
         ORDER BY u.created_at ASC
         LIMIT $1 OFFSET $2`,
        [safeBatch, riderOffset],
        { role: 'reader' }
      );

      if (!rows.length) break;
      for (const row of rows) {
        const result = await this.syncRiderByUserId(row.user_id);
        if (result.synced) ridersSynced += 1;
      }
      riderOffset += rows.length;
    }

    while (true) {
      const { rows } = await domainDb.query(
        'drivers',
        `SELECT d.id::text AS driver_lookup
         FROM drivers d
         ORDER BY d.created_at ASC
         LIMIT $1 OFFSET $2`,
        [safeBatch, driverOffset],
        { role: 'reader' }
      );

      if (!rows.length) break;
      for (const row of rows) {
        const result = await this.syncDriverByLookup(row.driver_lookup);
        if (result.synced) driversSynced += 1;
      }
      driverOffset += rows.length;
    }

    return {
      ridersSynced,
      driversSynced,
      totalSynced: ridersSynced + driversSynced,
    };
  }
}

module.exports = new DomainProjectionService();
