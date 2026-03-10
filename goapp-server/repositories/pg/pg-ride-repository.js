// PostgreSQL-backed Ride Repository
// Tables: rides, ride_status_history
// Used by ride-service.js when DB_BACKEND=pg

'use strict';

const domainDb = require('../../infra/db/domain-db');

class PgRideRepository {
  // ─── Create ───────────────────────────────────────────────────────────────

  async createRide({
    rideId, rideNumber, riderId, rideType,
    pickupLat, pickupLng, destLat, destLng,
    pickupZoneId, dropZoneId,
    fareEstimate, surgeMultiplier, idempotencyKey,
    outboxEvent = null,
  }) {
    const client = await domainDb.getClient('rides');
    try {
      await client.query('BEGIN');

      // riderId is users.id UUID, resolved from projection for domain isolation.
      const { rows: riderRows } = await client.query(
        `SELECT rider_id AS id
         FROM ride_rider_projection
         WHERE user_id = $1
         LIMIT 1`,
        [riderId]
      );
      if (!riderRows.length) {
        throw new Error(`Rider projection not found for user ${riderId}. Run projection backfill.`);
      }
      const dbRiderId = riderRows[0].id;

      const { rows } = await client.query(
        `INSERT INTO rides
           (id, ride_number, rider_id, ride_type,
            pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
            pickup_zone_id, drop_zone_id,
            estimated_fare, surge_multiplier, status, idempotency_key)
         VALUES ($1, $2, $3, 'on_demand', $4, $5, $6, $7, $8, $9, $10, $11, 'requested', $12)
         RETURNING id, ride_number, status, pickup_zone_id AS "pickupZoneId", drop_zone_id AS "dropZoneId",
                   EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"`,
        [
          rideId, rideNumber || rideId.slice(0, 20), dbRiderId,
          pickupLat, pickupLng, destLat, destLng,
          pickupZoneId || null, dropZoneId || null,
          fareEstimate, surgeMultiplier, idempotencyKey || null,
        ]
      );

      await client.query(
        `INSERT INTO ride_status_history (ride_id, new_status) VALUES ($1, 'requested')`,
        [rows[0].id]
      );

      if (outboxEvent) {
        await this._insertOutboxWithClient(client, 'rides', outboxEvent);
      }

      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  async getRide(rideId) {
    const { rows } = await domainDb.query(
      'rides',
      `SELECT r.ride_number AS "rideId", r.status,
              r.id AS "dbRideId",
              r.pickup_lat AS "pickupLat", r.pickup_lng AS "pickupLng",
              r.dropoff_lat AS "destLat", r.dropoff_lng AS "destLng",
              r.pickup_zone_id AS "pickupZoneId", r.drop_zone_id AS "dropZoneId",
              r.pickup_address AS "pickupAddress",
              r.dropoff_address AS "destAddress",
              r.ride_type AS "rideType",
              r.estimated_fare AS "estimatedFare", r.actual_fare AS "finalFare",
              r.surge_multiplier AS "surgeMultiplier",
              r.idempotency_key AS "idempotencyKey",
              rrp.user_id AS "riderId",
              rdp.user_id AS "driverId",
              EXTRACT(EPOCH FROM r.arrived_at)    * 1000 AS "arrivedAt",
              EXTRACT(EPOCH FROM r.accepted_at)   * 1000 AS "acceptedAt",
              EXTRACT(EPOCH FROM r.started_at)    * 1000 AS "startedAt",
              EXTRACT(EPOCH FROM r.completed_at)  * 1000 AS "completedAt",
              EXTRACT(EPOCH FROM r.cancelled_at)  * 1000 AS "cancelledAt",
              EXTRACT(EPOCH FROM r.created_at)    * 1000 AS "createdAt"
       FROM rides r
       LEFT JOIN ride_rider_projection rrp ON rrp.rider_id = r.rider_id
       LEFT JOIN ride_driver_projection rdp ON rdp.driver_id = r.driver_id
       WHERE r.id::text = $1 OR r.ride_number = $1`,
      [rideId]
    );
    return rows[0] || null;
  }

  async getAllRides(limit = 200) {
    const page = await this.getRidesPage({ limit, cursor: null });
    return page.rides;
  }

  async getRidesPage({ limit = 50, cursor = null } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    let cursorCreatedAt = null;
    let cursorDbRideId = null;

    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
        cursorCreatedAt = decoded.createdAt || null;
        cursorDbRideId = decoded.dbRideId || null;
      } catch (_) {
        cursorCreatedAt = null;
        cursorDbRideId = null;
      }
    }

    const hasCursor = Boolean(cursorCreatedAt && cursorDbRideId);
    const { rows } = await domainDb.query(
      'rides',
      `SELECT r.id AS "dbRideId",
              r.ride_number AS "rideId",
              r.status,
              r.ride_type AS "rideType",
              r.pickup_lat AS "pickupLat",
              r.pickup_lng AS "pickupLng",
              r.dropoff_lat AS "destLat",
              r.dropoff_lng AS "destLng",
              r.pickup_zone_id AS "pickupZoneId",
              r.drop_zone_id AS "dropZoneId",
              r.pickup_address AS "pickupAddress",
              r.dropoff_address AS "destAddress",
              r.estimated_fare AS "estimatedFare",
              r.actual_fare AS "finalFare",
              rrp.user_id AS "riderId",
              rdp.user_id AS "driverId",
              EXTRACT(EPOCH FROM r.accepted_at)   * 1000 AS "acceptedAt",
              EXTRACT(EPOCH FROM r.arrived_at)    * 1000 AS "arrivedAt",
              EXTRACT(EPOCH FROM r.started_at)    * 1000 AS "startedAt",
              EXTRACT(EPOCH FROM r.completed_at)  * 1000 AS "completedAt",
              EXTRACT(EPOCH FROM r.cancelled_at)  * 1000 AS "cancelledAt",
              EXTRACT(EPOCH FROM r.created_at)    * 1000 AS "createdAt"
       FROM rides r
       LEFT JOIN ride_rider_projection rrp ON rrp.rider_id = r.rider_id
       LEFT JOIN ride_driver_projection rdp ON rdp.driver_id = r.driver_id
       WHERE ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid))
       ORDER BY r.created_at DESC
       LIMIT $1`,
      [safeLimit + 1, hasCursor ? cursorCreatedAt : null, hasCursor ? cursorDbRideId : null]
    );

    const hasNext = rows.length > safeLimit;
    const pageRows = hasNext ? rows.slice(0, safeLimit) : rows;
    const last = pageRows[pageRows.length - 1] || null;
    const nextCursor = hasNext && last
      ? Buffer.from(JSON.stringify({
        createdAt: new Date(Number(last.createdAt)).toISOString(),
        dbRideId: last.dbRideId,
      })).toString('base64')
      : null;

    return { rides: pageRows, nextCursor };
  }

  async getRideByIdempotencyKey(key) {
    const { rows } = await domainDb.query(
      'rides',
      `SELECT id AS "dbRideId", ride_number AS "rideId", status
         FROM rides
        WHERE idempotency_key = $1`,
      [key]
    );
    return rows[0] || null;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  async updateStatus(rideId, status, extra = {}) {
    const {
      driverDbId, acceptedAt, startedAt, completedAt,
      cancelledAt, cancelledBy, finalFare, actualDistanceM, actualDurationS,
    } = extra;

    const { rows } = await domainDb.query(
      'rides',
      `WITH updated AS (
         UPDATE rides SET
           status       = $2,
           driver_id    = COALESCE($3, driver_id),
           accepted_at  = COALESCE($4, accepted_at),
           started_at   = COALESCE($5, started_at),
           completed_at = COALESCE($6, completed_at),
           cancelled_at = COALESCE($7, cancelled_at),
           actual_fare  = COALESCE($8, actual_fare),
           actual_distance_m  = COALESCE($9,  actual_distance_m),
           actual_duration_s  = COALESCE($10, actual_duration_s),
           updated_at   = NOW()
         WHERE id::text = $1 OR ride_number = $1
         RETURNING id, ride_number, status
       ),
       history AS (
         INSERT INTO ride_status_history (ride_id, new_status)
         SELECT id, $2 FROM updated
       )
       SELECT id AS "dbRideId", ride_number AS "rideId", status FROM updated`,
      [
        rideId, status,
        driverDbId   || null,
        acceptedAt   ? new Date(acceptedAt)   : null,
        startedAt    ? new Date(startedAt)    : null,
        completedAt  ? new Date(completedAt)  : null,
        cancelledAt  ? new Date(cancelledAt)  : null,
        finalFare    || null,
        actualDistanceM  || null,
        actualDurationS  || null,
      ]
    );

    return rows[0] || null;
  }

  // Resolve driver external_id → DB UUID for FK usage
  async resolveDriverDbId(driverExternalId) {
    const { rows } = await domainDb.query(
      'rides',
      `SELECT driver_id AS id
       FROM ride_driver_projection
       WHERE user_id::text = $1
          OR driver_id::text = $1
       LIMIT 1`,
      [driverExternalId]
    );
    return rows[0]?.id || null;
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  async getStats() {
    const { rows } = await domainDb.query(
      'analytics',
      `SELECT
         COUNT(*)                                                           AS "totalRides",
         COUNT(*) FILTER (WHERE status = 'completed')                      AS "completedRides",
         COALESCE(SUM(actual_fare) FILTER (WHERE status = 'completed'), 0) AS "totalRevenue",
         COALESCE(
           AVG(EXTRACT(EPOCH FROM (accepted_at - requested_at)))
           FILTER (WHERE accepted_at IS NOT NULL), 0
         )                                                                  AS "avgMatchTimeSec"
       FROM rides`
    );
    const r = rows[0];
    return {
      totalRides:       parseInt(r.totalRides),
      completedRides:   parseInt(r.completedRides),
      totalRevenue:     `₹${parseFloat(r.totalRevenue).toFixed(2)}`,
      avgMatchTimeSec:  Math.round(parseFloat(r.avgMatchTimeSec)),
    };
  }

  async _insertOutboxWithClient(client, domain, event) {
    await client.query(
      `INSERT INTO outbox_events (
         id,
         domain,
         topic,
         partition_key,
         event_type,
         aggregate_type,
         aggregate_id,
         event_version,
         payload,
         region,
         idempotency_key,
         status,
         available_at,
         created_at,
         updated_at
       ) VALUES (
         gen_random_uuid(),
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         COALESCE($7, 1),
         $8::jsonb,
         COALESCE($9, 'ap-south-1'),
         $10,
         'pending',
         NOW(),
         NOW(),
         NOW()
       )
       ON CONFLICT (domain, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING`,
      [
        domain,
        event.topic,
        event.partitionKey || null,
        event.eventType,
        event.aggregateType,
        event.aggregateId,
        event.version || 1,
        JSON.stringify(event.payload || {}),
        event.region || null,
        event.idempotencyKey || null,
      ]
    );
  }
}

module.exports = new PgRideRepository();
