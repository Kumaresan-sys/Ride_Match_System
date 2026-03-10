// PostgreSQL-backed Ride Repository
// Tables: rides, ride_status_history
// Used by ride-service.js when DB_BACKEND=pg

'use strict';

const domainDb = require('../../infra/db/domain-db');

function toDbRideStatus(status) {
  const normalized = String(status || '').trim().toUpperCase();
  switch (normalized) {
    case 'REQUESTED':
      return 'requested';
    case 'MATCHING':
    case 'BROADCAST':
      return 'searching';
    case 'ACCEPTED':
      return 'driver_assigned';
    case 'DRIVER_ARRIVING':
      return 'driver_arriving';
    case 'DRIVER_ARRIVED':
      return 'driver_arrived';
    case 'TRIP_STARTED':
      return 'ride_started';
    case 'TRIP_COMPLETED':
      return 'completed';
    case 'CANCELLED_BY_RIDER':
    case 'CANCELLED_BY_DRIVER':
      return 'cancelled';
    case 'NO_DRIVERS':
      return 'no_drivers';
    case 'FAILED':
      return 'failed';
    default:
      return String(status || '').trim().toLowerCase() || 'requested';
  }
}

class PgRideRepository {
  // ─── Create ───────────────────────────────────────────────────────────────

  async createRide({
    rideId, rideNumber, riderId, rideType,
    pickupLat, pickupLng, destLat, destLng,
    pickupAddress, destAddress,
    estimatedDistanceM, estimatedDurationS,
    fareEstimateDetails = null,
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
            pickup_address, dropoff_address,
            estimated_distance_m, estimated_duration_s,
            pickup_zone_id, drop_zone_id,
            estimated_fare, surge_multiplier, status, idempotency_key)
         VALUES ($1, $2, $3, 'on_demand', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'requested', $16)
         RETURNING id, ride_number, status, pickup_zone_id AS "pickupZoneId", drop_zone_id AS "dropZoneId",
                   EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"`,
        [
          rideId, rideNumber || rideId.slice(0, 20), dbRiderId,
          pickupLat, pickupLng, destLat, destLng,
          pickupAddress || null, destAddress || null,
          estimatedDistanceM || null, estimatedDurationS || null,
          pickupZoneId || null, dropZoneId || null,
          fareEstimate, surgeMultiplier, idempotencyKey || null,
        ]
      );

      await client.query(
        `INSERT INTO ride_status_history (ride_id, new_status, metadata)
         VALUES ($1, 'requested', $2::jsonb)`,
        [
          rows[0].id,
          JSON.stringify({
            requestedServiceType: rideType || null,
            pickupAddress: pickupAddress || null,
            destAddress: destAddress || null,
            estimatedDistanceM: estimatedDistanceM || null,
            estimatedDurationS: estimatedDurationS || null,
            requestedBaseFare: fareEstimateDetails?.breakdown?.baseFare ?? null,
            requestedDistanceCharge:
              fareEstimateDetails?.breakdown?.distanceCharge ?? null,
            requestedTimeCharge: fareEstimateDetails?.breakdown?.timeCharge ?? null,
            requestedSubtotal: fareEstimateDetails?.breakdown?.subtotal ?? null,
            requestedServiceCost:
              fareEstimateDetails?.breakdown?.serviceCost ??
              fareEstimateDetails?.serviceCost ??
              null,
            requestedGstPct:
              fareEstimateDetails?.breakdown?.gstPct ??
              fareEstimateDetails?.gstPct ??
              null,
            requestedGstAmount:
              fareEstimateDetails?.breakdown?.gstAmount ??
              fareEstimateDetails?.gstAmount ??
              null,
            requestedCommissionPct:
              fareEstimateDetails?.breakdown?.commissionPct ??
              fareEstimateDetails?.commissionPct ??
              null,
            requestedSurgeMultiplier:
              fareEstimateDetails?.breakdown?.surgeMultiplier ??
              surgeMultiplier ??
              null,
            requestedPlatformCommission:
              fareEstimateDetails?.platformCommission ?? null,
          }),
        ]
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
              r.pickup_zone_id AS "pickupZoneId",
              pzc.zone_code AS "pickupZoneCode",
              pzc.zone_name AS "pickupZoneName",
              pzc.city AS "pickupZoneCity",
              pzc.state AS "pickupZoneState",
              pzc.country AS "pickupZoneCountry",
              r.drop_zone_id AS "dropZoneId",
              dzc.zone_code AS "dropZoneCode",
              dzc.zone_name AS "dropZoneName",
              dzc.city AS "dropZoneCity",
              dzc.state AS "dropZoneState",
              dzc.country AS "dropZoneCountry",
              COALESCE(r.pickup_address, req_hist."requestedPickupAddress", req_oe."requestedPickupAddress") AS "pickupAddress",
              COALESCE(r.dropoff_address, req_hist."requestedDestAddress", req_oe."requestedDestAddress") AS "destAddress",
              r.ride_type AS "rideType",
              r.estimated_distance_m AS "estimatedDistanceM",
              r.actual_distance_m AS "actualDistanceM",
              r.estimated_duration_s AS "estimatedDurationS",
              r.actual_duration_s AS "actualDurationS",
              r.estimated_fare AS "estimatedFare", r.actual_fare AS "finalFare",
              r.surge_multiplier AS "surgeMultiplier",
              r.idempotency_key AS "idempotencyKey",
              rfb.base_fare AS "baseFare",
              rfb.distance_fare AS "distanceFare",
              rfb.time_fare AS "timeFare",
              rfb.surge_amount AS "surgeAmount",
              rfb.surge_multiplier AS "fareBreakdownSurgeMultiplier",
              rfb.platform_commission AS "platformCommission",
              rrp.user_id AS "riderId",
              rdp.user_id AS "driverId",
              rc."cancelledBy",
              rc."cancellerId",
              rc."cancellationReasonCode",
              rc."cancellationReasonText",
              rc."cancellationFee",
              COALESCE(req_hist."requestedServiceType", req_oe."requestedServiceType") AS "requestedServiceType",
              COALESCE(req_hist."requestedEstimatedDistanceM", req_oe."requestedEstimatedDistanceM") AS "requestedEstimatedDistanceM",
              COALESCE(req_hist."requestedEstimatedDurationS", req_oe."requestedEstimatedDurationS") AS "requestedEstimatedDurationS",
              COALESCE(req_hist."requestedBaseFare", req_oe."requestedBaseFare") AS "requestedBaseFare",
              COALESCE(req_hist."requestedDistanceCharge", req_oe."requestedDistanceCharge") AS "requestedDistanceCharge",
              COALESCE(req_hist."requestedTimeCharge", req_oe."requestedTimeCharge") AS "requestedTimeCharge",
              COALESCE(req_hist."requestedSubtotal", req_oe."requestedSubtotal") AS "requestedSubtotal",
              COALESCE(req_hist."requestedServiceCost", req_oe."requestedServiceCost") AS "requestedServiceCost",
              COALESCE(req_hist."requestedGstPct", req_oe."requestedGstPct") AS "requestedGstPct",
              COALESCE(req_hist."requestedGstAmount", req_oe."requestedGstAmount") AS "requestedGstAmount",
              COALESCE(req_hist."requestedCommissionPct", req_oe."requestedCommissionPct") AS "requestedCommissionPct",
              COALESCE(req_hist."requestedSurgeMultiplier", req_oe."requestedSurgeMultiplier") AS "requestedSurgeMultiplier",
              COALESCE(req_hist."requestedPlatformCommission", req_oe."requestedPlatformCommission") AS "requestedPlatformCommission",
              rfb.platform_fee AS "platformFee",
              rfb.booking_fee AS "bookingFee",
              rfb.taxes AS "taxes",
              EXTRACT(EPOCH FROM rc."cancellationRecordedAt") * 1000 AS "cancellationRecordedAt",
              EXTRACT(EPOCH FROM r.arrived_at)    * 1000 AS "arrivedAt",
              EXTRACT(EPOCH FROM r.accepted_at)   * 1000 AS "acceptedAt",
              EXTRACT(EPOCH FROM r.started_at)    * 1000 AS "startedAt",
              EXTRACT(EPOCH FROM r.completed_at)  * 1000 AS "completedAt",
              EXTRACT(EPOCH FROM r.cancelled_at)  * 1000 AS "cancelledAt",
              EXTRACT(EPOCH FROM r.created_at)    * 1000 AS "createdAt"
       FROM rides r
       LEFT JOIN ride_rider_projection rrp ON rrp.rider_id = r.rider_id
       LEFT JOIN ride_driver_projection rdp ON rdp.driver_id = r.driver_id
       LEFT JOIN zone_catalog pzc ON pzc.id = r.pickup_zone_id
       LEFT JOIN zone_catalog dzc ON dzc.id = r.drop_zone_id
       LEFT JOIN ride_fare_breakdown rfb ON rfb.ride_id = r.id
       LEFT JOIN LATERAL (
         SELECT
           metadata->>'requestedServiceType' AS "requestedServiceType",
           metadata->>'pickupAddress' AS "requestedPickupAddress",
           metadata->>'destAddress' AS "requestedDestAddress",
           (metadata->>'estimatedDistanceM')::integer AS "requestedEstimatedDistanceM",
           (metadata->>'estimatedDurationS')::integer AS "requestedEstimatedDurationS",
           (metadata->>'requestedBaseFare')::numeric AS "requestedBaseFare",
           (metadata->>'requestedDistanceCharge')::numeric AS "requestedDistanceCharge",
           (metadata->>'requestedTimeCharge')::numeric AS "requestedTimeCharge",
           (metadata->>'requestedSubtotal')::numeric AS "requestedSubtotal",
           (metadata->>'requestedServiceCost')::numeric AS "requestedServiceCost",
           (metadata->>'requestedGstPct')::numeric AS "requestedGstPct",
           (metadata->>'requestedGstAmount')::numeric AS "requestedGstAmount",
           (metadata->>'requestedCommissionPct')::numeric AS "requestedCommissionPct",
           (metadata->>'requestedSurgeMultiplier')::numeric AS "requestedSurgeMultiplier",
           (metadata->>'requestedPlatformCommission')::numeric AS "requestedPlatformCommission"
         FROM ride_status_history
         WHERE ride_id = r.id
           AND new_status = 'requested'
         ORDER BY created_at ASC
         LIMIT 1
       ) req_hist ON true
       LEFT JOIN LATERAL (
         SELECT
           payload->>'rideType' AS "requestedServiceType",
           payload->>'pickupAddress' AS "requestedPickupAddress",
           payload->>'destAddress' AS "requestedDestAddress",
           (payload->>'estimatedDistanceM')::integer AS "requestedEstimatedDistanceM",
           (payload->>'estimatedDurationS')::integer AS "requestedEstimatedDurationS",
           (payload->>'baseFare')::numeric AS "requestedBaseFare",
           (payload->>'distanceCharge')::numeric AS "requestedDistanceCharge",
           (payload->>'timeCharge')::numeric AS "requestedTimeCharge",
           (payload->>'subtotal')::numeric AS "requestedSubtotal",
           (payload->>'serviceCost')::numeric AS "requestedServiceCost",
           (payload->>'gstPct')::numeric AS "requestedGstPct",
           (payload->>'gstAmount')::numeric AS "requestedGstAmount",
           (payload->>'commissionPct')::numeric AS "requestedCommissionPct",
           (payload->>'surgeMultiplier')::numeric AS "requestedSurgeMultiplier",
           (payload->>'platformCommission')::numeric AS "requestedPlatformCommission"
         FROM outbox_events
         WHERE aggregate_type = 'ride'
           AND aggregate_id = r.ride_number
           AND topic = 'ride_requested'
         ORDER BY created_at ASC
         LIMIT 1
       ) req_oe ON true
       LEFT JOIN LATERAL (
         SELECT
           rc.cancelled_by AS "cancelledBy",
           rc.canceller_id AS "cancellerId",
           rc.reason_code AS "cancellationReasonCode",
           rc.reason_text AS "cancellationReasonText",
           rc.cancellation_fee AS "cancellationFee",
           rc.cancelled_at AS "cancellationRecordedAt"
         FROM ride_cancellations rc
         WHERE rc.ride_id = r.id
         ORDER BY rc.cancelled_at DESC
         LIMIT 1
       ) rc ON true
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
              pzc.zone_code AS "pickupZoneCode",
              pzc.zone_name AS "pickupZoneName",
              pzc.city AS "pickupZoneCity",
              pzc.state AS "pickupZoneState",
              pzc.country AS "pickupZoneCountry",
              r.drop_zone_id AS "dropZoneId",
              dzc.zone_code AS "dropZoneCode",
              dzc.zone_name AS "dropZoneName",
              dzc.city AS "dropZoneCity",
              dzc.state AS "dropZoneState",
              dzc.country AS "dropZoneCountry",
              COALESCE(r.pickup_address, req_hist."requestedPickupAddress", req_oe."requestedPickupAddress") AS "pickupAddress",
              COALESCE(r.dropoff_address, req_hist."requestedDestAddress", req_oe."requestedDestAddress") AS "destAddress",
              r.estimated_distance_m AS "estimatedDistanceM",
              r.actual_distance_m AS "actualDistanceM",
              r.estimated_duration_s AS "estimatedDurationS",
              r.actual_duration_s AS "actualDurationS",
              r.estimated_fare AS "estimatedFare",
              r.actual_fare AS "finalFare",
              rfb.base_fare AS "baseFare",
              rfb.distance_fare AS "distanceFare",
              rfb.time_fare AS "timeFare",
              rfb.surge_amount AS "surgeAmount",
              rfb.surge_multiplier AS "fareBreakdownSurgeMultiplier",
              rfb.platform_commission AS "platformCommission",
              rrp.user_id AS "riderId",
              rdp.user_id AS "driverId",
              rc."cancelledBy",
              rc."cancellerId",
              rc."cancellationReasonCode",
              rc."cancellationReasonText",
              rc."cancellationFee",
              COALESCE(req_hist."requestedServiceType", req_oe."requestedServiceType") AS "requestedServiceType",
              COALESCE(req_hist."requestedEstimatedDistanceM", req_oe."requestedEstimatedDistanceM") AS "requestedEstimatedDistanceM",
              COALESCE(req_hist."requestedEstimatedDurationS", req_oe."requestedEstimatedDurationS") AS "requestedEstimatedDurationS",
              COALESCE(req_hist."requestedBaseFare", req_oe."requestedBaseFare") AS "requestedBaseFare",
              COALESCE(req_hist."requestedDistanceCharge", req_oe."requestedDistanceCharge") AS "requestedDistanceCharge",
              COALESCE(req_hist."requestedTimeCharge", req_oe."requestedTimeCharge") AS "requestedTimeCharge",
              COALESCE(req_hist."requestedSubtotal", req_oe."requestedSubtotal") AS "requestedSubtotal",
              COALESCE(req_hist."requestedServiceCost", req_oe."requestedServiceCost") AS "requestedServiceCost",
              COALESCE(req_hist."requestedGstPct", req_oe."requestedGstPct") AS "requestedGstPct",
              COALESCE(req_hist."requestedGstAmount", req_oe."requestedGstAmount") AS "requestedGstAmount",
              COALESCE(req_hist."requestedCommissionPct", req_oe."requestedCommissionPct") AS "requestedCommissionPct",
              COALESCE(req_hist."requestedSurgeMultiplier", req_oe."requestedSurgeMultiplier") AS "requestedSurgeMultiplier",
              COALESCE(req_hist."requestedPlatformCommission", req_oe."requestedPlatformCommission") AS "requestedPlatformCommission",
              rfb.platform_fee AS "platformFee",
              rfb.booking_fee AS "bookingFee",
              rfb.taxes AS "taxes",
              EXTRACT(EPOCH FROM rc."cancellationRecordedAt") * 1000 AS "cancellationRecordedAt",
              EXTRACT(EPOCH FROM r.accepted_at)   * 1000 AS "acceptedAt",
              EXTRACT(EPOCH FROM r.arrived_at)    * 1000 AS "arrivedAt",
              EXTRACT(EPOCH FROM r.started_at)    * 1000 AS "startedAt",
              EXTRACT(EPOCH FROM r.completed_at)  * 1000 AS "completedAt",
              EXTRACT(EPOCH FROM r.cancelled_at)  * 1000 AS "cancelledAt",
              EXTRACT(EPOCH FROM r.created_at)    * 1000 AS "createdAt"
       FROM rides r
       LEFT JOIN ride_rider_projection rrp ON rrp.rider_id = r.rider_id
       LEFT JOIN ride_driver_projection rdp ON rdp.driver_id = r.driver_id
       LEFT JOIN zone_catalog pzc ON pzc.id = r.pickup_zone_id
       LEFT JOIN zone_catalog dzc ON dzc.id = r.drop_zone_id
       LEFT JOIN ride_fare_breakdown rfb ON rfb.ride_id = r.id
       LEFT JOIN LATERAL (
         SELECT
           metadata->>'requestedServiceType' AS "requestedServiceType",
           metadata->>'pickupAddress' AS "requestedPickupAddress",
           metadata->>'destAddress' AS "requestedDestAddress",
           (metadata->>'estimatedDistanceM')::integer AS "requestedEstimatedDistanceM",
           (metadata->>'estimatedDurationS')::integer AS "requestedEstimatedDurationS",
           (metadata->>'requestedBaseFare')::numeric AS "requestedBaseFare",
           (metadata->>'requestedDistanceCharge')::numeric AS "requestedDistanceCharge",
           (metadata->>'requestedTimeCharge')::numeric AS "requestedTimeCharge",
           (metadata->>'requestedSubtotal')::numeric AS "requestedSubtotal",
           (metadata->>'requestedServiceCost')::numeric AS "requestedServiceCost",
           (metadata->>'requestedGstPct')::numeric AS "requestedGstPct",
           (metadata->>'requestedGstAmount')::numeric AS "requestedGstAmount",
           (metadata->>'requestedCommissionPct')::numeric AS "requestedCommissionPct",
           (metadata->>'requestedSurgeMultiplier')::numeric AS "requestedSurgeMultiplier",
           (metadata->>'requestedPlatformCommission')::numeric AS "requestedPlatformCommission"
         FROM ride_status_history
         WHERE ride_id = r.id
           AND new_status = 'requested'
         ORDER BY created_at ASC
         LIMIT 1
       ) req_hist ON true
       LEFT JOIN LATERAL (
         SELECT
           payload->>'rideType' AS "requestedServiceType",
           payload->>'pickupAddress' AS "requestedPickupAddress",
           payload->>'destAddress' AS "requestedDestAddress",
           (payload->>'estimatedDistanceM')::integer AS "requestedEstimatedDistanceM",
           (payload->>'estimatedDurationS')::integer AS "requestedEstimatedDurationS",
           (payload->>'baseFare')::numeric AS "requestedBaseFare",
           (payload->>'distanceCharge')::numeric AS "requestedDistanceCharge",
           (payload->>'timeCharge')::numeric AS "requestedTimeCharge",
           (payload->>'subtotal')::numeric AS "requestedSubtotal",
           (payload->>'serviceCost')::numeric AS "requestedServiceCost",
           (payload->>'gstPct')::numeric AS "requestedGstPct",
           (payload->>'gstAmount')::numeric AS "requestedGstAmount",
           (payload->>'commissionPct')::numeric AS "requestedCommissionPct",
           (payload->>'surgeMultiplier')::numeric AS "requestedSurgeMultiplier",
           (payload->>'platformCommission')::numeric AS "requestedPlatformCommission"
         FROM outbox_events
         WHERE aggregate_type = 'ride'
         AND aggregate_id = r.ride_number
           AND topic = 'ride_requested'
         ORDER BY created_at ASC
         LIMIT 1
       ) req_oe ON true
       LEFT JOIN LATERAL (
         SELECT
           rc.cancelled_by AS "cancelledBy",
           rc.canceller_id AS "cancellerId",
           rc.reason_code AS "cancellationReasonCode",
           rc.reason_text AS "cancellationReasonText",
           rc.cancellation_fee AS "cancellationFee",
           rc.cancelled_at AS "cancellationRecordedAt"
         FROM ride_cancellations rc
         WHERE rc.ride_id = r.id
         ORDER BY rc.cancelled_at DESC
         LIMIT 1
       ) rc ON true
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

    const dbStatus = toDbRideStatus(status);

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
        rideId, dbStatus,
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

  async insertRideEvent(rideId, eventType, eventData = {}, extra = {}) {
    const actorType = extra.actorType || null;
    const actorId = extra.actorId || null;
    const rideRef = String(rideId || '').trim();
    if (!rideRef) return null;

    const { rows } = await domainDb.query(
      'rides',
      `WITH resolved AS (
         SELECT id
         FROM rides
         WHERE id::text = $1 OR ride_number = $1
         LIMIT 1
       )
       INSERT INTO ride_events (
         ride_id,
         event_type,
         event_data,
         actor_type,
         actor_id
       )
       SELECT
         id,
         $2,
         $3::jsonb,
         $4,
         $5
       FROM resolved
       RETURNING
         id,
         ride_id AS "dbRideId",
         event_type AS "eventType",
         created_at AS "createdAt"`,
      [
        rideRef,
        eventType,
        JSON.stringify(eventData || {}),
        actorType,
        actorId,
      ]
    );

    return rows[0] || null;
  }

  async insertRideCancellation(rideId, details = {}, client = null) {
    const rideRef = String(rideId || '').trim();
    if (!rideRef) return null;

    const cancelledAt = details.cancelledAt ? new Date(details.cancelledAt) : null;
    const sql = `WITH resolved AS (
        SELECT id
        FROM rides
        WHERE id::text = $1 OR ride_number = $1
        LIMIT 1
      )
      INSERT INTO ride_cancellations (
        ride_id,
        reason_catalog_id,
        cancelled_by,
        canceller_id,
        reason_code,
        reason_text,
        cancellation_fee,
        is_fee_waived,
        waiver_reason,
        time_since_request,
        time_since_accept,
        driver_distance_m,
        cancelled_at
      )
      SELECT
        id,
        $2,
        $3,
        $4,
        $5,
        $6,
        COALESCE($7, 0),
        COALESCE($8, false),
        $9,
        $10,
        $11,
        $12,
        COALESCE($13::timestamptz, NOW())
      FROM resolved
      RETURNING
        id,
        ride_id AS "dbRideId",
        reason_catalog_id AS "reasonCatalogId",
        cancelled_by AS "cancelledBy",
        reason_code AS "reasonCode",
        reason_text AS "reasonText",
        cancelled_at AS "cancelledAt"`;

    const params = [
      rideRef,
      details.reasonCatalogId || null,
      details.cancelledBy,
      details.cancellerId || null,
      details.reasonCode || null,
      details.reasonText || null,
      details.cancellationFee ?? 0,
      details.isFeeWaived ?? false,
      details.waiverReason || null,
      details.timeSinceRequest ?? null,
      details.timeSinceAccept ?? null,
      details.driverDistanceM ?? null,
      cancelledAt,
    ];
    const { rows } = client
      ? await client.query(sql, params)
      : await domainDb.query('rides', sql, params);

    return rows[0] || null;
  }

  async recordCancellation(rideId, details = {}, options = {}) {
    const rideRef = String(rideId || '').trim();
    if (!rideRef) return null;

    return domainDb.withTransaction('rides', async (client) => {
      const { rows: resolvedRows } = await client.query(
        `SELECT id, ride_number
         FROM rides
         WHERE id::text = $1 OR ride_number = $1
         LIMIT 1
         FOR UPDATE`,
        [rideRef]
      );
      if (!resolvedRows.length) {
        return null;
      }

      const resolvedRideId = resolvedRows[0].id;
      let updatedRide = null;
      if (options.status) {
        const dbStatus = toDbRideStatus(options.status);
        const cancelledAt = details.cancelledAt ? new Date(details.cancelledAt) : null;
        const setCancelledAt = options.setCancelledAt !== false;
        const { rows } = await client.query(
          `UPDATE rides
           SET status = $2,
               cancelled_at = CASE
                 WHEN $4 THEN COALESCE($3, cancelled_at)
                 ELSE cancelled_at
               END,
               updated_at = NOW()
           WHERE id = $1
           RETURNING id AS "dbRideId", ride_number AS "rideId", status`,
          [resolvedRideId, dbStatus, cancelledAt, setCancelledAt]
        );
        updatedRide = rows[0] || null;
        await client.query(
          `INSERT INTO ride_status_history (ride_id, new_status)
           VALUES ($1, $2)`,
          [resolvedRideId, dbStatus]
        );
      }

      const cancellation = await this.insertRideCancellation(rideRef, details, client);

      if (options.eventType) {
        await client.query(
          `INSERT INTO ride_events (
             ride_id,
             event_type,
             event_data,
             actor_type,
             actor_id
           )
           VALUES ($1, $2, $3::jsonb, $4, $5)`,
          [
            resolvedRideId,
            options.eventType,
            JSON.stringify({
              cancelledBy: details.cancelledBy || null,
              reasonCatalogId: details.reasonCatalogId || null,
              reasonCode: details.reasonCode || null,
              reasonText: details.reasonText || null,
              cancellationFee: details.cancellationFee ?? 0,
              cancelledAt: details.cancelledAt || null,
            }),
            options.actorType || details.cancelledBy || null,
            options.actorId || details.cancellerId || null,
          ]
        );
      }

      return {
        ride: updatedRide,
        cancellation,
      };
    });
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
