'use strict';

const domainDb = require('../../infra/db/domain-db');

class PgZoneMetricsRepository {
  async _upsertHourlyMetric({
    zoneId,
    eventTime,
    requestedInc = 0,
    completedInc = 0,
    cancelledInc = 0,
    noDriverInc = 0,
    fareInr = null,
    waitSec = null,
    tripSec = null,
  }) {
    await domainDb.query('rides', 
      `INSERT INTO zone_metrics_hourly
         (zone_id, hour_start, requested_count, completed_count, cancelled_count, no_driver_count,
          total_fare, total_wait_sec, total_trip_sec, fare_samples, wait_samples, trip_samples, updated_at)
       VALUES (
         $1,
         (date_trunc('hour', ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata'),
         $3, $4, $5, $6,
         CASE WHEN $7 IS NULL THEN 0 ELSE $7 END,
         CASE WHEN $8 IS NULL THEN 0 ELSE $8 END,
         CASE WHEN $9 IS NULL THEN 0 ELSE $9 END,
         CASE WHEN $7 IS NULL THEN 0 ELSE 1 END,
         CASE WHEN $8 IS NULL THEN 0 ELSE 1 END,
         CASE WHEN $9 IS NULL THEN 0 ELSE 1 END,
         NOW()
       )
       ON CONFLICT (zone_id, hour_start)
       DO UPDATE SET
         requested_count = zone_metrics_hourly.requested_count + EXCLUDED.requested_count,
         completed_count = zone_metrics_hourly.completed_count + EXCLUDED.completed_count,
         cancelled_count = zone_metrics_hourly.cancelled_count + EXCLUDED.cancelled_count,
         no_driver_count = zone_metrics_hourly.no_driver_count + EXCLUDED.no_driver_count,
         total_fare = zone_metrics_hourly.total_fare + EXCLUDED.total_fare,
         total_wait_sec = zone_metrics_hourly.total_wait_sec + EXCLUDED.total_wait_sec,
         total_trip_sec = zone_metrics_hourly.total_trip_sec + EXCLUDED.total_trip_sec,
         fare_samples = zone_metrics_hourly.fare_samples + EXCLUDED.fare_samples,
         wait_samples = zone_metrics_hourly.wait_samples + EXCLUDED.wait_samples,
         trip_samples = zone_metrics_hourly.trip_samples + EXCLUDED.trip_samples,
         avg_fare = CASE
           WHEN (zone_metrics_hourly.fare_samples + EXCLUDED.fare_samples) > 0
             THEN ROUND((zone_metrics_hourly.total_fare + EXCLUDED.total_fare)
               / (zone_metrics_hourly.fare_samples + EXCLUDED.fare_samples), 2)
           ELSE NULL
         END,
         avg_wait_sec = CASE
           WHEN (zone_metrics_hourly.wait_samples + EXCLUDED.wait_samples) > 0
             THEN ROUND((zone_metrics_hourly.total_wait_sec + EXCLUDED.total_wait_sec)::numeric
               / (zone_metrics_hourly.wait_samples + EXCLUDED.wait_samples))
           ELSE NULL
         END,
         avg_trip_sec = CASE
           WHEN (zone_metrics_hourly.trip_samples + EXCLUDED.trip_samples) > 0
             THEN ROUND((zone_metrics_hourly.total_trip_sec + EXCLUDED.total_trip_sec)::numeric
               / (zone_metrics_hourly.trip_samples + EXCLUDED.trip_samples))
           ELSE NULL
         END,
         updated_at = NOW()`,
      [
        zoneId,
        eventTime,
        requestedInc,
        completedInc,
        cancelledInc,
        noDriverInc,
        fareInr,
        waitSec,
        tripSec,
      ],
    );
  }

  async _upsertUniqueRider({ zoneId, eventTime, riderId }) {
    if (!riderId) return;
    await domainDb.query('rides', 
      `WITH slot AS (
         SELECT (date_trunc('hour', ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata') AS hour_start
       ),
       ins AS (
         INSERT INTO zone_metrics_hourly_riders(zone_id, hour_start, rider_id)
         SELECT $1, slot.hour_start, $3::uuid FROM slot
         ON CONFLICT DO NOTHING
       )
       UPDATE zone_metrics_hourly h
       SET unique_riders = (
         SELECT COUNT(*)::int
         FROM zone_metrics_hourly_riders r, slot
         WHERE r.zone_id = $1 AND r.hour_start = slot.hour_start
       ),
       updated_at = NOW()
       FROM slot
       WHERE h.zone_id = $1 AND h.hour_start = slot.hour_start`,
      [zoneId, eventTime, riderId],
    );
  }

  async recordRequested({ zoneId, riderId, eventTime }) {
    await this._upsertHourlyMetric({
      zoneId,
      eventTime,
      requestedInc: 1,
    });
    await this._upsertUniqueRider({ zoneId, eventTime, riderId });
  }

  async recordCompleted({ zoneId, riderId, eventTime, fareInr = null, waitSec = null, tripSec = null }) {
    await this._upsertHourlyMetric({
      zoneId,
      eventTime,
      completedInc: 1,
      fareInr,
      waitSec,
      tripSec,
    });
    await this._upsertUniqueRider({ zoneId, eventTime, riderId });
  }

  async recordCancelled({ zoneId, riderId, eventTime }) {
    await this._upsertHourlyMetric({
      zoneId,
      eventTime,
      cancelledInc: 1,
    });
    await this._upsertUniqueRider({ zoneId, eventTime, riderId });
  }

  async recordNoDriver({ zoneId, riderId, eventTime }) {
    await this._upsertHourlyMetric({
      zoneId,
      eventTime,
      noDriverInc: 1,
    });
    await this._upsertUniqueRider({ zoneId, eventTime, riderId });
  }

  async refreshDailyPeaks(metricDate, zoneId = null) {
    const params = [metricDate];
    let zoneWhere = '';
    if (zoneId) {
      params.push(zoneId);
      zoneWhere = `AND z.zone_id = $2`;
    }

    await domainDb.query('rides', 
      `DELETE FROM zone_peak_windows_daily
       WHERE metric_date = $1
       ${zoneId ? 'AND zone_id = $2' : ''}`,
      params,
    );

    await domainDb.query('rides', 
      `INSERT INTO zone_peak_windows_daily (
         zone_id, metric_date, hour_start,
         requested_count, completed_count, cancelled_count,
         completion_ratio, rank, updated_at
       )
       SELECT
         z.zone_id,
         $1::date AS metric_date,
         z.hour_start,
         z.requested_count,
         z.completed_count,
         z.cancelled_count,
         CASE
           WHEN z.requested_count > 0 THEN ROUND((z.completed_count::numeric / z.requested_count), 4)
           ELSE 0
         END AS completion_ratio,
         z.rank,
         NOW()
       FROM (
         SELECT
           h.zone_id,
           h.hour_start,
           h.requested_count,
           h.completed_count,
           h.cancelled_count,
           ROW_NUMBER() OVER (
             PARTITION BY h.zone_id
             ORDER BY h.requested_count DESC,
                      CASE WHEN h.requested_count > 0 THEN (h.completed_count::numeric / h.requested_count) ELSE 0 END DESC,
                      h.hour_start ASC
           ) AS rank
         FROM zone_metrics_hourly h
         WHERE (h.hour_start AT TIME ZONE 'Asia/Kolkata')::date = $1::date
       ) z
       WHERE z.rank <= 3
       ${zoneWhere}`,
      params,
    );
  }

  async getHourly({ zoneId, from, to }) {
    const { rows } = await domainDb.query('rides', 
      `SELECT zmh.zone_id AS "zoneId",
              zc.zone_code AS "zoneCode",
              zc.zone_name AS "zoneName",
              zmh.hour_start AS "hourStart",
              zmh.requested_count AS "requestedCount",
              zmh.completed_count AS "completedCount",
              zmh.cancelled_count AS "cancelledCount",
              zmh.no_driver_count AS "noDriverCount",
              zmh.unique_riders AS "uniqueRiders",
              zmh.avg_fare AS "avgFare",
              zmh.avg_wait_sec AS "avgWaitSec",
              zmh.avg_trip_sec AS "avgTripSec"
       FROM zone_metrics_hourly zmh
       JOIN zone_catalog zc ON zc.id = zmh.zone_id
       WHERE zmh.zone_id = $1
         AND zmh.hour_start >= $2::timestamptz
         AND zmh.hour_start <= $3::timestamptz
       ORDER BY zmh.hour_start ASC`,
      [zoneId, from, to],
    );
    return rows;
  }

  async getSummaryByDate(metricDate) {
    const { rows } = await domainDb.query('rides', 
      `SELECT zc.id AS "zoneId",
              zc.zone_code AS "zoneCode",
              zc.zone_name AS "zoneName",
              COALESCE(SUM(h.requested_count), 0)::int AS "requestedCount",
              COALESCE(SUM(h.completed_count), 0)::int AS "completedCount",
              COALESCE(SUM(h.cancelled_count), 0)::int AS "cancelledCount",
              COALESCE(SUM(h.no_driver_count), 0)::int AS "noDriverCount",
              MAX(h.requested_count)::int AS "peakRequestedInHour"
       FROM zone_catalog zc
       LEFT JOIN zone_metrics_hourly h
         ON h.zone_id = zc.id
        AND (h.hour_start AT TIME ZONE 'Asia/Kolkata')::date = $1::date
       WHERE zc.is_active = true
       GROUP BY zc.id, zc.zone_code, zc.zone_name
       ORDER BY "requestedCount" DESC, zc.zone_name ASC`,
      [metricDate],
    );
    return rows;
  }

  async getPeaksByDate(metricDate) {
    const { rows } = await domainDb.query('rides', 
      `SELECT p.zone_id AS "zoneId",
              zc.zone_code AS "zoneCode",
              zc.zone_name AS "zoneName",
              p.metric_date AS "metricDate",
              p.hour_start AS "hourStart",
              p.requested_count AS "requestedCount",
              p.completed_count AS "completedCount",
              p.cancelled_count AS "cancelledCount",
              p.completion_ratio AS "completionRatio",
              p.rank
       FROM zone_peak_windows_daily p
       JOIN zone_catalog zc ON zc.id = p.zone_id
       WHERE p.metric_date = $1::date
       ORDER BY zc.zone_name ASC, p.rank ASC`,
      [metricDate],
    );
    return rows;
  }

  async reconcileFromRides() {
    await domainDb.query('rides', `TRUNCATE zone_metrics_hourly_riders, zone_metrics_hourly, zone_peak_windows_daily`);

    await domainDb.query('rides', 
      `INSERT INTO zone_metrics_hourly (
         zone_id, hour_start, requested_count, completed_count, cancelled_count, no_driver_count,
         unique_riders, avg_fare, avg_wait_sec, avg_trip_sec,
         total_fare, total_wait_sec, total_trip_sec, fare_samples, wait_samples, trip_samples, updated_at
       )
       SELECT
         r.pickup_zone_id AS zone_id,
         (date_trunc('hour', (r.requested_at AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata') AS hour_start,
         COUNT(*)::int AS requested_count,
         COUNT(*) FILTER (WHERE r.status = 'completed')::int AS completed_count,
         COUNT(*) FILTER (WHERE r.status LIKE 'cancelled%')::int AS cancelled_count,
         COUNT(*) FILTER (WHERE r.status = 'no_drivers')::int AS no_driver_count,
         COUNT(DISTINCT r.rider_id)::int AS unique_riders,
         ROUND(AVG(r.actual_fare) FILTER (WHERE r.actual_fare IS NOT NULL), 2) AS avg_fare,
         ROUND(AVG(EXTRACT(EPOCH FROM (r.accepted_at - r.requested_at))) FILTER (WHERE r.accepted_at IS NOT NULL))::int AS avg_wait_sec,
         ROUND(AVG(r.actual_duration_s) FILTER (WHERE r.actual_duration_s IS NOT NULL))::int AS avg_trip_sec,
         COALESCE(SUM(r.actual_fare) FILTER (WHERE r.actual_fare IS NOT NULL), 0) AS total_fare,
         COALESCE(SUM(EXTRACT(EPOCH FROM (r.accepted_at - r.requested_at))) FILTER (WHERE r.accepted_at IS NOT NULL), 0)::bigint AS total_wait_sec,
         COALESCE(SUM(r.actual_duration_s) FILTER (WHERE r.actual_duration_s IS NOT NULL), 0)::bigint AS total_trip_sec,
         COUNT(r.actual_fare) FILTER (WHERE r.actual_fare IS NOT NULL)::int AS fare_samples,
         COUNT(*) FILTER (WHERE r.accepted_at IS NOT NULL)::int AS wait_samples,
         COUNT(*) FILTER (WHERE r.actual_duration_s IS NOT NULL)::int AS trip_samples,
         NOW()
       FROM rides r
       WHERE r.pickup_zone_id IS NOT NULL
       GROUP BY r.pickup_zone_id,
                (date_trunc('hour', (r.requested_at AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata')`,
    );
  }
}

module.exports = new PgZoneMetricsRepository();
