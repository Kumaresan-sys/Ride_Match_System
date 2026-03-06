// GoApp Demand Aggregation Service
//
// Pools multiple ride requests going in the same direction into a single shared ride.
// Reduces costs for riders and increases driver earnings per trip.
//
// Pooling Rules:
//   - Pickup must be within POOL_PICKUP_RADIUS_KM (default 1km) of pool origin
//   - Destination bearing must be within POOL_BEARING_TOLERANCE_DEG (default 35°) of pool direction
//   - Destination distance must be compatible (within POOL_DEST_RANGE_KM = 3km of pool dest)
//   - Max riders per pool: POOL_MAX_RIDERS (default 4)
//   - Pool expires if not filled within POOL_EXPIRY_SEC (default 300s = 5 min)
//   - Fare per rider = full_fare * POOL_DISCOUNT_PCT (default 60% of individual fare)
//
// Every scenario is fully logged via demand-log-service.js:
//   pool_created, pool_joined, pool_left, no_match_found,
//   match_attempt, pool_dispatched, pool_expired, pool_completed, pool_cancelled

const { logger, eventBus } = require('../utils/logger');
const { haversine, bearing } = require('../utils/formulas');
const demandLog = require('./demand-log-service');

const POOL_MAX_RIDERS          = parseInt(process.env.POOL_MAX_RIDERS || '4', 10);
const POOL_PICKUP_RADIUS_KM    = parseFloat(process.env.POOL_PICKUP_RADIUS_KM || '1.0');
const POOL_BEARING_TOLERANCE   = parseFloat(process.env.POOL_BEARING_TOLERANCE_DEG || '35');
const POOL_DEST_RANGE_KM       = parseFloat(process.env.POOL_DEST_RANGE_KM || '3.0');
const POOL_EXPIRY_SEC          = parseInt(process.env.POOL_EXPIRY_SEC || '300', 10);
const POOL_DISCOUNT_PCT        = parseFloat(process.env.POOL_DISCOUNT_PCT || '0.60');

class DemandAggregationService {
  constructor() {
    this.pools = new Map();
    // Clean expired pools every 2 minutes
    this._cleanupInterval = setInterval(() => this._cleanExpiredPools(), 2 * 60 * 1000);
    this._cleanupInterval.unref();
  }

  // ─── Create a new pool ────────────────────────────────────────────────────
  createPool({ riderId, pickupLat, pickupLng, destLat, destLng, fareInr, rideType = 'sedan' }) {
    if (!riderId || !pickupLat || !pickupLng || !destLat || !destLng) {
      return { success: false, error: 'riderId, pickupLat, pickupLng, destLat, destLng required.' };
    }

    const poolId     = `POOL-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const direction  = bearing(pickupLat, pickupLng, destLat, destLng);
    const distKm     = haversine(pickupLat, pickupLng, destLat, destLng);
    const pooledFare = Math.round(fareInr * POOL_DISCOUNT_PCT * 100) / 100;
    const savingsInr = Math.round((fareInr - pooledFare) * 100) / 100;
    const expiresAt  = new Date(Date.now() + POOL_EXPIRY_SEC * 1000).toISOString();

    const pool = {
      poolId,
      status: 'OPEN',
      rideType,
      pickupLat,
      pickupLng,
      destLat,
      destLng,
      directionBearing:   Math.round(direction * 10) / 10,
      distanceKm:         Math.round(distKm * 100) / 100,
      fullFareInr:        fareInr,
      farePerRiderInr:    pooledFare,
      savingsPerRiderInr: savingsInr,
      maxRiders:          POOL_MAX_RIDERS,
      riders:             [{ riderId, joinedAt: new Date().toISOString(), pickupLat, pickupLng }],
      driverId:           null,
      rideId:             null,
      expiresAt,
      createdAt:          new Date().toISOString(),
      updatedAt:          new Date().toISOString(),
    };

    this.pools.set(poolId, pool);

    // ── Demand Log: pool_created ──
    demandLog.recordDemand(pickupLat, pickupLng, 'pool_created');
    demandLog.recordTimeslot('pool_created');
    demandLog.logScenario('pool_created', {
      poolId,
      riderId,
      pickupLat,
      pickupLng,
      destLat,
      destLng,
      bearing:         pool.directionBearing,
      distanceKm:      pool.distanceKm,
      fareInr,
      farePerRiderInr: pooledFare,
      savingsInr,
      discountPct:     Math.round((1 - POOL_DISCOUNT_PCT) * 100),
      expiresAt,
      rideType,
      outcome:         'created',
    });

    eventBus.publish('pool_created', { poolId, riderId, pickupLat, pickupLng, destLat, destLng });
    logger.info('POOL', `Pool ${poolId} created by rider ${riderId}. Direction: ${pool.directionBearing}°. Fare/rider: ₹${pooledFare}`);

    return { success: true, pool };
  }

  // ─── Find compatible pool — returns { pool, failReasons } ────────────────
  // failReasons: [{poolId, reason, value, threshold}] for complete no-match logging
  findCompatiblePool({ riderId, pickupLat, pickupLng, destLat, destLng, rideType = 'sedan' }) {
    if (!pickupLat || !pickupLng || !destLat || !destLng) return { pool: null, failReasons: [] };

    const reqBearing  = bearing(pickupLat, pickupLng, destLat, destLng);
    const now         = new Date();
    const failReasons = [];

    for (const [poolId, pool] of this.pools) {
      if (pool.riders.some(r => r.riderId === riderId)) {
        failReasons.push({ poolId, reason: 'already_in_pool', value: null, threshold: null });
        continue;
      }
      if (new Date(pool.expiresAt) < now) {
        failReasons.push({ poolId, reason: 'pool_expired', value: null, threshold: null });
        continue;
      }
      if (pool.status !== 'OPEN' && pool.status !== 'FILLING') {
        failReasons.push({ poolId, reason: 'pool_wrong_status', value: pool.status, threshold: 'OPEN|FILLING' });
        continue;
      }
      if (pool.riders.length >= pool.maxRiders) {
        failReasons.push({ poolId, reason: 'pool_full', value: pool.riders.length, threshold: pool.maxRiders });
        continue;
      }
      if (pool.rideType !== rideType) {
        failReasons.push({ poolId, reason: 'ride_type_mismatch', value: pool.rideType, threshold: rideType });
        continue;
      }

      const pickupDist = haversine(pickupLat, pickupLng, pool.pickupLat, pool.pickupLng);
      if (pickupDist > POOL_PICKUP_RADIUS_KM) {
        failReasons.push({ poolId, reason: 'pickup_too_far', value: Math.round(pickupDist * 100) / 100, threshold: POOL_PICKUP_RADIUS_KM });
        continue;
      }

      let bearingDiff = Math.abs(reqBearing - pool.directionBearing);
      if (bearingDiff > 180) bearingDiff = 360 - bearingDiff;
      if (bearingDiff > POOL_BEARING_TOLERANCE) {
        failReasons.push({ poolId, reason: 'bearing_mismatch', value: Math.round(bearingDiff * 10) / 10, threshold: POOL_BEARING_TOLERANCE });
        continue;
      }

      const destDist = haversine(destLat, destLng, pool.destLat, pool.destLng);
      if (destDist > POOL_DEST_RANGE_KM) {
        failReasons.push({ poolId, reason: 'dest_too_far', value: Math.round(destDist * 100) / 100, threshold: POOL_DEST_RANGE_KM });
        continue;
      }

      // All checks passed
      return { pool, failReasons };
    }

    return { pool: null, failReasons };
  }

  // ─── Join an existing pool ────────────────────────────────────────────────
  joinPool(poolId, { riderId, pickupLat, pickupLng }) {
    const pool = this.pools.get(poolId);
    if (!pool) return { success: false, error: 'Pool not found.' };
    if (pool.status !== 'OPEN' && pool.status !== 'FILLING') {
      return { success: false, error: `Pool is ${pool.status}, cannot join.` };
    }
    if (pool.riders.length >= pool.maxRiders) {
      return { success: false, error: 'Pool is full.' };
    }
    if (new Date(pool.expiresAt) < new Date()) {
      pool.status = 'EXPIRED';
      return { success: false, error: 'Pool has expired.' };
    }
    if (pool.riders.some(r => r.riderId === riderId)) {
      return { success: false, error: 'Rider already in this pool.' };
    }

    const joinedAt   = new Date().toISOString();
    pool.riders.push({ riderId, joinedAt, pickupLat, pickupLng });
    pool.updatedAt   = joinedAt;
    if (pool.riders.length >= pool.maxRiders) pool.status = 'FILLING';

    const waitTimeSec = Math.round((new Date(joinedAt) - new Date(pool.createdAt)) / 1000);
    const savingsInr  = Math.round((pool.fullFareInr - pool.farePerRiderInr) * 100) / 100;

    // ── Demand Log: pool_joined ──
    demandLog.logScenario('pool_joined', {
      poolId,
      riderId,
      riderCount:      pool.riders.length,
      maxRiders:       pool.maxRiders,
      farePerRiderInr: pool.farePerRiderInr,
      savingsInr,
      waitTimeSec,
      poolCreatedAt:   pool.createdAt,
      pickupLat,
      pickupLng,
      outcome:         'joined',
    });
    demandLog.recordTimeslot('pool_joined', { waitSec: waitTimeSec, savingsInr });

    eventBus.publish('pool_joined', { poolId, riderId, riderCount: pool.riders.length });
    logger.info('POOL', `Rider ${riderId} joined pool ${poolId}. Riders: ${pool.riders.length}/${pool.maxRiders}. Wait: ${waitTimeSec}s`);

    return {
      success: true,
      pool,
      riderCount:      pool.riders.length,
      farePerRiderInr: pool.farePerRiderInr,
      savings:         savingsInr,
      waitTimeSec,
    };
  }

  // ─── Smart match: find or create pool ────────────────────────────────────
  smartMatch({ riderId, pickupLat, pickupLng, destLat, destLng, fareInr, rideType = 'sedan' }) {
    const matchStart = Date.now();

    const { pool: existingPool, failReasons } = this.findCompatiblePool({
      riderId, pickupLat, pickupLng, destLat, destLng, rideType,
    });

    if (existingPool) {
      const joinResult = this.joinPool(existingPool.poolId, { riderId, pickupLat, pickupLng });
      if (joinResult.success) {
        demandLog.logScenario('match_attempt', {
          riderId,
          pickupLat, pickupLng, destLat, destLng,
          poolsChecked:    failReasons.length + 1,
          outcome:         'joined',
          matchTimeSec:    (Date.now() - matchStart) / 1000,
          poolId:          existingPool.poolId,
          farePerRiderInr: joinResult.farePerRiderInr,
        });
        return {
          action:          'joined_pool',
          pool:            joinResult.pool,
          farePerRiderInr: joinResult.farePerRiderInr,
          savings:         joinResult.savings,
          waitTimeSec:     joinResult.waitTimeSec,
          message:         `Joined existing pool with ${joinResult.pool.riders.length} riders.`,
        };
      }
    }

    // Log no_match_found with complete fail details
    demandLog.logScenario('no_match_found', {
      riderId,
      pickupLat, pickupLng, destLat, destLng,
      bearing:           Math.round(bearing(pickupLat, pickupLng, destLat, destLng) * 10) / 10,
      checkedPoolsCount: failReasons.length,
      failReasons,
      rideType,
      fareInr,
      outcome:           'no_match',
    });
    demandLog.recordTimeslot('no_match_found');

    // Create a new pool
    const createResult = this.createPool({ riderId, pickupLat, pickupLng, destLat, destLng, fareInr, rideType });
    if (createResult.success) {
      demandLog.logScenario('match_attempt', {
        riderId,
        pickupLat, pickupLng, destLat, destLng,
        poolsChecked:    failReasons.length,
        outcome:         'created',
        matchTimeSec:    (Date.now() - matchStart) / 1000,
        poolId:          createResult.pool.poolId,
        farePerRiderInr: createResult.pool.farePerRiderInr,
      });
      return {
        action:          'created_pool',
        pool:            createResult.pool,
        farePerRiderInr: createResult.pool.farePerRiderInr,
        savings:         createResult.pool.savingsPerRiderInr,
        message:         'New pool created. Waiting for more riders to join.',
      };
    }

    return { action: 'failed', error: createResult.error };
  }

  // ─── Assign driver to pool (dispatch) ────────────────────────────────────
  dispatchDriver(poolId, driverId, rideId = null) {
    const pool = this.pools.get(poolId);
    if (!pool) return { success: false, error: 'Pool not found.' };
    if (!['OPEN', 'FILLING'].includes(pool.status)) {
      return { success: false, error: `Cannot dispatch to pool in status ${pool.status}.` };
    }

    const dispatchedAt   = new Date().toISOString();
    pool.driverId        = driverId;
    pool.rideId          = rideId;
    pool.status          = 'DISPATCHING';
    pool.updatedAt       = dispatchedAt;

    const totalFare  = Math.round(pool.farePerRiderInr * pool.riders.length * 100) / 100;
    const waitedSec  = Math.round((new Date(dispatchedAt) - new Date(pool.createdAt)) / 1000);

    // ── Demand Log: pool_dispatched ──
    demandLog.logScenario('pool_dispatched', {
      poolId,
      driverId,
      rideId,
      riderCount:      pool.riders.length,
      farePerRiderInr: pool.farePerRiderInr,
      totalFareInr:    totalFare,
      waitedSec,
      pickupLat:       pool.pickupLat,
      pickupLng:       pool.pickupLng,
      outcome:         'dispatched',
    });
    demandLog.releaseRequest(pool.pickupLat, pool.pickupLng, false);

    eventBus.publish('pool_dispatched', { poolId, driverId, rideId, riders: pool.riders.length });
    logger.info('POOL', `Driver ${driverId} dispatched to pool ${poolId} (${pool.riders.length} riders). Total: ₹${totalFare}`);

    return { success: true, pool };
  }

  // ─── Update pool status ───────────────────────────────────────────────────
  updateStatus(poolId, status) {
    const pool = this.pools.get(poolId);
    if (!pool) return { success: false, error: 'Pool not found.' };

    const validStatuses = ['OPEN', 'FILLING', 'DISPATCHING', 'ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
      return { success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` };
    }

    pool.status    = status;
    pool.updatedAt = new Date().toISOString();

    if (status === 'COMPLETED') {
      pool.completedAt   = pool.updatedAt;
      const durationSec  = Math.round((new Date(pool.completedAt) - new Date(pool.createdAt)) / 1000);
      const totalSavings = Math.round(pool.savingsPerRiderInr * pool.riders.length * 100) / 100;

      // ── Demand Log: pool_completed ──
      demandLog.logScenario('pool_completed', {
        poolId,
        riderCount:      pool.riders.length,
        farePerRiderInr: pool.farePerRiderInr,
        fullFareInr:     pool.fullFareInr,
        totalSavingsInr: totalSavings,
        savingsPerRider: pool.savingsPerRiderInr,
        durationSec,
        driverId:        pool.driverId,
        pickupLat:       pool.pickupLat,
        pickupLng:       pool.pickupLng,
        outcome:         'completed',
      });
      demandLog.recordTimeslot('pool_completed', { savingsInr: totalSavings });
      demandLog.recordSavings(pool.pickupLat, pool.pickupLng, totalSavings);
    }

    return { success: true, pool };
  }

  // ─── Rider leaves pool ────────────────────────────────────────────────────
  leavePool(poolId, riderId) {
    const pool = this.pools.get(poolId);
    if (!pool) return { success: false, error: 'Pool not found.' };
    if (!['OPEN', 'FILLING'].includes(pool.status)) {
      return { success: false, error: 'Cannot leave pool after dispatch.' };
    }

    pool.riders    = pool.riders.filter(r => r.riderId !== riderId);
    pool.updatedAt = new Date().toISOString();

    const cancelled = pool.riders.length === 0;
    if (cancelled) {
      pool.status = 'CANCELLED';
      demandLog.logScenario('pool_cancelled', {
        poolId, lastRiderId: riderId, reason: 'all_riders_left',
        pickupLat: pool.pickupLat, pickupLng: pool.pickupLng, outcome: 'cancelled',
      });
      demandLog.recordTimeslot('pool_cancelled');
      demandLog.releaseRequest(pool.pickupLat, pool.pickupLng, true);
    } else {
      pool.status = 'OPEN';
    }

    // ── Demand Log: pool_left ──
    demandLog.logScenario('pool_left', {
      poolId, riderId,
      ridersRemaining: pool.riders.length,
      poolStatus:      pool.status,
      pickupLat:       pool.pickupLat,
      pickupLng:       pool.pickupLng,
      outcome:         cancelled ? 'pool_cancelled' : 'pool_still_open',
    });

    return { success: true, pool, ridersRemaining: pool.riders.length };
  }

  // ─── Get pool details ─────────────────────────────────────────────────────
  getPool(poolId) {
    return this.pools.get(poolId) || null;
  }

  // ─── List all pools (admin) ───────────────────────────────────────────────
  listPools({ status, limit = 50 } = {}) {
    const all      = Array.from(this.pools.values());
    const filtered = status ? all.filter(p => p.status === status) : all;
    return filtered
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, Math.min(limit, 200));
  }

  // ─── Pools for a specific rider ───────────────────────────────────────────
  getRiderPools(riderId) {
    const result = [];
    this.pools.forEach(pool => {
      if (pool.riders.some(r => r.riderId === riderId)) result.push(pool);
    });
    return result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // ─── Clean expired pools + log each expiry ────────────────────────────────
  _cleanExpiredPools() {
    const now     = new Date();
    let cleaned   = 0;

    this.pools.forEach((pool, poolId) => {
      if (['OPEN', 'FILLING'].includes(pool.status) && new Date(pool.expiresAt) < now) {
        pool.status    = 'EXPIRED';
        pool.updatedAt = now.toISOString();
        cleaned++;

        const livedSec = Math.round((now - new Date(pool.createdAt)) / 1000);

        // ── Demand Log: pool_expired ──
        demandLog.logScenario('pool_expired', {
          poolId,
          livedSec,
          finalRiderCount: pool.riders.length,
          maxRiders:       pool.maxRiders,
          fillRate:        Math.round((pool.riders.length / pool.maxRiders) * 100) + '%',
          pickupLat:       pool.pickupLat,
          pickupLng:       pool.pickupLng,
          rideType:        pool.rideType,
          outcome:         'expired',
        });
        demandLog.recordTimeslot('pool_expired');
        demandLog.releaseRequest(pool.pickupLat, pool.pickupLng, true);

        eventBus.publish('pool_expired', { poolId, riders: pool.riders.length });
      }
    });

    if (cleaned > 0) logger.info('POOL', `Cleaned ${cleaned} expired pools.`);
  }

  // ─── Stats ────────────────────────────────────────────────────────────────
  getStats() {
    const counts = { OPEN: 0, FILLING: 0, DISPATCHING: 0, ACTIVE: 0, COMPLETED: 0, EXPIRED: 0, CANCELLED: 0 };
    let totalRidersPooled = 0;
    this.pools.forEach(pool => {
      counts[pool.status] = (counts[pool.status] || 0) + 1;
      if (pool.status === 'COMPLETED') totalRidersPooled += pool.riders.length;
    });
    return {
      totalPools:       this.pools.size,
      statusBreakdown:  counts,
      totalRidersPooled,
      poolDiscountPct:  Math.round((1 - POOL_DISCOUNT_PCT) * 100),
      maxRidersPerPool: POOL_MAX_RIDERS,
      config: {
        pickupRadiusKm:   POOL_PICKUP_RADIUS_KM,
        bearingTolerance: POOL_BEARING_TOLERANCE,
        destRangeKm:      POOL_DEST_RANGE_KM,
        expirySec:        POOL_EXPIRY_SEC,
      },
    };
  }
}

module.exports = new DemandAggregationService();
